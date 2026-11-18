import { syntaxTree } from '@codemirror/language';
import {
    EditorSelection,
    EditorState,
    RangeSet,
    type Extension,
    type SelectionRange,
    type Transaction,
} from '@codemirror/state';
import { EditorView, ViewPlugin, type Decoration, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';

import type { CodeMirrorControl, MarkdownEditorContentScriptModule } from 'api/types';

/**
 * Fixes mouse selections that split Markdown syntax hidden by Joplin's "render markup" mode
 * (https://github.com/laurent22/joplin/issues/16546).
 *
 * While markup is hidden, the positions on either side of a hidden mark (e.g. the `**` in
 * `**bold**`) look identical, so a mouse selection can land on either side. Once the selection
 * is released, Joplin reveals the marks and the selection turns out to contain only one of the
 * pair (`**bold` or `bold**`).
 *
 * A transaction filter snaps each pointer-selection endpoint that sits inside a hidden mark:
 * - if the selection covers the construct's whole visible content, outward (include the marks);
 * - otherwise, to the side that excludes the mark.
 *
 * Because this happens while dragging (when the marks are still hidden), the selection looks the
 * same to the user and nothing jumps when the marks are revealed on mouse up.
 */

export interface Span {
    from: number;
    to: number;
}

/** A Markdown construct whose syntax marks Joplin may hide. */
export interface MarkupConstruct {
    /** Start of the opening mark. */
    from: number;
    /** Start of the visible content (after the hidden opening mark). */
    contentFrom: number;
    /** End of the visible content. */
    contentTo: number;
    /** End of the closing mark (equal to `contentTo` for line prefixes like `# `). */
    to: number;
    /** Syntax node whose hidden state controls snapping at the start. */
    openMark: Span;
    /** Span whose hidden state controls snapping at the end, or `null` for line prefixes. */
    closeMark: Span | null;
}

export type HiddenCheck = (span: Span) => boolean;

const INLINE_MARKS = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark', 'HighlightMarker', 'InsertMarker']);
// Bullet list marks are not included: Joplin replaces them with a visible widget, so the positions
// on either side of a bullet are not ambiguous.
const PREFIX_MARKS = new Set(['HeaderMark', 'QuoteMark']);
const INLINE_HTML_TAG = /^<(\/?)(sub|sup|strike|span)(?=[\s>])/i;
const MAX_PASSES = 8;

/**
 * Constructs wrapped in a pair of marks: `**bold**`, `` `code` ``, `~~strike~~`, etc. This also
 * covers fenced code blocks, whose ``` fences Joplin hides unless the cursor is on the fence line.
 * The content of a fenced block starts after the opening backticks (the language stays visible).
 * Unterminated blocks have no closing CodeMark and are skipped.
 */
const getWrappedConstruct = (node: SyntaxNode): MarkupConstruct | null => {
    const open = node.firstChild;
    const close = node.lastChild;
    if (!open || !close || open.from === close.from) return null;
    if (!INLINE_MARKS.has(open.name) || close.name !== open.name) return null;
    if (open.from !== node.from || close.to !== node.to) return null;

    return {
        from: node.from,
        contentFrom: open.to,
        contentTo: close.from,
        to: node.to,
        openMark: open,
        closeMark: close,
    };
};

const readInlineHtmlTag = (node: SyntaxNode, state: EditorState) => {
    if (node.name !== 'HTMLTag') return null;
    const [, slash, name] = INLINE_HTML_TAG.exec(state.sliceDoc(node.from, node.to)) ?? [];
    return name ? { name: name.toLowerCase(), closing: slash === '/' } : null;
};

/** Joplin pairs inline HTML tags among siblings, counting nested tags of the same name. */
const getInlineHtmlConstruct = (node: SyntaxNode, state: EditorState): MarkupConstruct | null => {
    const tag = readInlineHtmlTag(node, state);
    if (!tag) return null;

    const sibling = tag.closing ? 'prevSibling' : 'nextSibling';
    let depth = 1;
    for (let other = node[sibling]; other; other = other[sibling]) {
        const otherTag = readInlineHtmlTag(other, state);
        if (otherTag?.name !== tag.name) continue;
        depth += otherTag.closing === tag.closing ? 1 : -1;
        if (depth !== 0) continue;

        const [open, close] = tag.closing ? [other, node] : [node, other];
        return {
            from: open.from,
            contentFrom: open.to,
            contentTo: close.from,
            to: close.to,
            openMark: open,
            closeMark: close,
        };
    }
    return null;
};

/** A link's closing syntax can span several decorations and contain visible text, such as a title. */
const getLinkConstruct = (node: SyntaxNode, state: EditorState): MarkupConstruct | null => {
    const marks = node.getChildren('LinkMark');
    const open = marks[0];
    if (!open || open.from !== node.from || state.sliceDoc(open.from, open.to) !== '[') return null;

    const close = marks.filter((mark) => state.sliceDoc(mark.from, mark.to) === ']').pop();
    if (!close) return null;

    return {
        from: node.from,
        contentFrom: open.to,
        contentTo: close.from,
        to: node.to,
        openMark: open,
        closeMark: { from: close.from, to: node.to },
    };
};

const isLinePrefix = (mark: SyntaxNode, state: EditorState): boolean => {
    switch (mark.name) {
        case 'HeaderMark':
            // Excludes closing `##` marks and setext underlines.
            return mark.parent?.from === mark.from;
        case 'QuoteMark':
            return mark.from === state.doc.lineAt(mark.from).from;
        default:
            return false;
    }
};

/**
 * `# ` and `>` prefixes: the visible content runs to the end of the line. Joplin hides the space
 * after a heading mark, but leaves the space after a quote mark visible.
 * For `# Heading ##`, a drag that reaches the line end already includes the closing hashes.
 * A drag that stops before them is treated as a partial heading selection.
 */
const getPrefixConstruct = (mark: SyntaxNode, state: EditorState): MarkupConstruct | null => {
    if (!isLinePrefix(mark, state)) return null;

    const line = state.doc.lineAt(mark.from);
    const hiddenSpace = mark.name === 'HeaderMark' && state.sliceDoc(mark.to, mark.to + 1) === ' ' ? 1 : 0;
    return {
        from: mark.from,
        contentFrom: Math.min(mark.to + hiddenSpace, line.to),
        contentTo: line.to,
        to: line.to,
        openMark: mark,
        closeMark: null,
    };
};

export const getConstruct = (node: SyntaxNode, state: EditorState): MarkupConstruct | null => {
    if (node.name === 'Link') return getLinkConstruct(node, state);
    if (node.name === 'HTMLTag') return getInlineHtmlConstruct(node, state);
    if (PREFIX_MARKS.has(node.name)) return getPrefixConstruct(node, state);
    return getWrappedConstruct(node);
};

/** Collects constructs on the lines containing the given positions. */
const collectConstructs = (state: EditorState, positions: readonly number[]): MarkupConstruct[] => {
    const tree = syntaxTree(state);
    const constructs: MarkupConstruct[] = [];
    const seenLines = new Set<number>();
    const seenHtmlTags = new Set<number>();

    for (const pos of positions) {
        const line = state.doc.lineAt(pos);
        if (seenLines.has(line.number)) continue;
        seenLines.add(line.number);

        tree.iterate({
            from: line.from,
            to: line.to,
            enter: ({ name, from, node }) => {
                if (name === 'HTMLTag' && seenHtmlTags.has(from)) return;

                const construct = getConstruct(node, state);
                if (!construct) return;
                // HTML constructs always have a closeMark; the check narrows the type.
                if (name === 'HTMLTag' && construct.closeMark) {
                    seenHtmlTags.add(construct.openMark.from);
                    seenHtmlTags.add(construct.closeMark.from);
                }
                constructs.push(construct);
            },
        });
    }
    return constructs;
};

const inRange = (pos: number, from: number, to: number) => pos >= from && pos <= to;

/** Endpoints inside the hidden opening mark (`[start, contentFrom]`). */
const snapToOpenMark = ({ from, to }: Span, { from: start, contentFrom }: MarkupConstruct, covers: boolean): Span => ({
    from: inRange(from, start, contentFrom) ? (covers ? start : contentFrom) : from,
    to: inRange(to, start, contentFrom) ? start : to,
});

/** Endpoints inside the hidden closing mark (`[contentTo, end]`). */
const snapToCloseMark = ({ from, to }: Span, { contentTo, to: end }: MarkupConstruct, covers: boolean): Span => ({
    from: inRange(from, contentTo, end) ? end : from,
    to: inRange(to, contentTo, end) ? (covers ? end : contentTo) : to,
});

/** Applies one construct's snapping rules to a selection span. */
const snapToConstruct = (span: Span, construct: MarkupConstruct, isHidden: HiddenCheck): Span => {
    const { from: start, contentFrom, contentTo, to: end, openMark, closeMark } = construct;
    const { from, to } = span;

    if (contentFrom >= contentTo) return span;

    // Remember a hidden mark even if the selection hasn't extended past it yet.
    if (inRange(from, start, contentFrom) && inRange(to, start, contentFrom)) {
        isHidden(openMark);
        return span;
    }
    if (inRange(from, contentTo, end) && inRange(to, contentTo, end)) {
        if (closeMark) isHidden(closeMark);
        return span;
    }

    const covers = from <= contentFrom && to >= contentTo;
    let result = span;
    if (isHidden(openMark)) result = snapToOpenMark(result, construct, covers);
    if (closeMark && isHidden(closeMark)) result = snapToCloseMark(result, construct, covers);
    return result;
};

/** Snaps a selection span against all constructs until it stops changing (handles nesting). */
export const snapSpan = (span: Span, constructs: readonly MarkupConstruct[], isHidden: HiddenCheck): Span => {
    let current = span;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
        const before = current;
        for (const construct of constructs) {
            current = snapToConstruct(current, construct, isHidden);
        }
        if (current.from === before.from && current.to === before.to) break;
    }
    return current;
};

const snapRange = (state: EditorState, range: SelectionRange, isHidden: HiddenCheck): SelectionRange => {
    const constructs = collectConstructs(state, [range.from, range.to]);
    if (range.empty) {
        // The anchor can scroll away before the selection expands. Remember its marks without moving the caret.
        for (const { from, contentFrom, contentTo, to, openMark, closeMark } of constructs) {
            if (inRange(range.anchor, from, contentFrom)) isHidden(openMark);
            if (closeMark && inRange(range.anchor, contentTo, to)) isHidden(closeMark);
        }
        return range;
    }

    const { from, to } = snapSpan({ from: range.from, to: range.to }, constructs, isHidden);
    if (from === range.from && to === range.to) return range;

    // Preserve the selection direction.
    return range.anchor <= range.head ? EditorSelection.range(from, to) : EditorSelection.range(to, from);
};

export const snapSelection = (
    state: EditorState,
    selection: EditorSelection,
    isHidden: HiddenCheck
): EditorSelection => {
    const ranges = selection.ranges.map((range) => snapRange(state, range, isHidden));
    return EditorSelection.create(ranges, selection.mainIndex);
};

/**
 * Joplin hides marks with a near-zero-width `cm-hidden` mark decoration. Replace widgets (bullets,
 * checkboxes) are visible, so they don't make positions ambiguous and aren't treated as hidden.
 */
const isHidingDecoration = (decoration: Decoration): boolean => {
    const className = (decoration.spec as { class?: unknown }).class;
    return typeof className === 'string' && className.split(/\s+/).includes('cm-hidden');
};

/** Checks the view's current decorations, so marks Joplin has revealed are left alone. */
const isHiddenNow = (view: EditorView): HiddenCheck => {
    let sets: DecorationSet[] | null = null;
    return ({ from, to }) => {
        sets ??= view.state
            .facet(EditorView.decorations)
            .map((source) => (typeof source === 'function' ? source(view) : source));
        let hiddenTo = from;
        for (const cursor = RangeSet.iter(sets, from); cursor.value && cursor.from <= hiddenTo; cursor.next()) {
            if (!isHidingDecoration(cursor.value)) continue;
            hiddenTo = Math.max(hiddenTo, cursor.to);
            if (hiddenTo >= to) return true;
        }
        return false;
    };
};

// Transaction filters don't receive the view, so track views to read their decorations.
const views = new Set<EditorView>();

const spanKey = ({ from, to }: Span) => `${from}:${to}`;

/**
 * Tracks a view and remembers which marks were hidden during the current mouse gesture.
 *
 * Joplin only decorates the visible part of the document, so a mark that scrolls out of view
 * mid-drag loses its decoration even though it is still hidden: Joplin keeps the reveal state
 * fixed for the whole gesture. Without this memory, the anchor's snap would be undone once its
 * construct leaves the viewport.
 */
class GestureTracker {
    private hiddenDuringGesture = new Set<string>();

    public constructor(private view: EditorView) {
        views.add(view);
        // Capture phase, so the memory is cleared before CodeMirror handles the new gesture.
        view.dom.addEventListener('mousedown', this.reset, true);
    }

    public update(update: ViewUpdate) {
        const pointerSelection = update.transactions.some((tr) => tr.isUserEvent('select.pointer'));
        if (update.docChanged || (update.selectionSet && !pointerSelection)) this.reset();
    }

    public destroy() {
        views.delete(this.view);
        this.view.dom.removeEventListener('mousedown', this.reset, true);
    }

    public hiddenCheck(): HiddenCheck {
        const isHidden = isHiddenNow(this.view);
        return (span) => {
            const key = spanKey(span);
            if (this.hiddenDuringGesture.has(key)) return true;
            if (!isHidden(span)) return false;
            this.hiddenDuringGesture.add(key);
            return true;
        };
    }

    private reset = () => {
        this.hiddenDuringGesture.clear();
    };
}

const gestureTracker = ViewPlugin.fromClass(GestureTracker);

const findView = (state: EditorState): EditorView | undefined => {
    for (const view of views) {
        if (view.state === state) return view;
    }
    return undefined;
};

const selectionFilter = EditorState.transactionFilter.of((tr: Transaction) => {
    if (!tr.selection || tr.docChanged || !tr.isUserEvent('select.pointer')) return tr;

    const tracker = findView(tr.startState)?.plugin(gestureTracker);
    if (!tracker) return tr;

    const snapped = snapSelection(tr.startState, tr.selection, tracker.hiddenCheck());
    if (snapped.eq(tr.selection)) return tr;
    return [tr, { selection: snapped }];
});

export const selectionFixExtension: Extension = [gestureTracker, selectionFilter];

export default (): MarkdownEditorContentScriptModule => {
    return {
        plugin: (codeMirrorWrapper: CodeMirrorControl) => {
            if (!codeMirrorWrapper.cm6) return;
            codeMirrorWrapper.addExtension(selectionFixExtension);
        },
    };
};
