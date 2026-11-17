import { syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState, type Extension, type SelectionRange, type Transaction } from '@codemirror/state';
import { EditorView, ViewPlugin, type Decoration, type DecorationSet } from '@codemirror/view';
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
    /** Syntax node whose hidden state controls snapping at the end, or `null` for line prefixes. */
    closeMark: Span | null;
}

export type HiddenCheck = (span: Span) => boolean;

const INLINE_MARKS = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark', 'HighlightMarker', 'InsertMarker']);
// Bullet list marks are not included: Joplin replaces them with a visible widget, so the positions
// on either side of a bullet are not ambiguous.
const PREFIX_MARKS = new Set(['HeaderMark', 'QuoteMark']);
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

/** `[label](url)`: the visible content is `label`; `[` and `](url)` are hidden. */
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
        closeMark: close,
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
    if (PREFIX_MARKS.has(node.name)) return getPrefixConstruct(node, state);
    return getWrappedConstruct(node);
};

/** Collects constructs on the lines containing the given positions. */
const collectConstructs = (state: EditorState, positions: readonly number[]): MarkupConstruct[] => {
    const tree = syntaxTree(state);
    const constructs: MarkupConstruct[] = [];
    const seenLines = new Set<number>();

    for (const pos of positions) {
        const line = state.doc.lineAt(pos);
        if (seenLines.has(line.number)) continue;
        seenLines.add(line.number);

        tree.iterate({
            from: line.from,
            to: line.to,
            enter: (ref) => {
                const construct = getConstruct(ref.node, state);
                if (construct) constructs.push(construct);
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

    // Ignore empty content and selections lying entirely inside one mark.
    if (contentFrom >= contentTo) return span;
    if (inRange(from, start, contentFrom) && inRange(to, start, contentFrom)) return span;
    if (inRange(from, contentTo, end) && inRange(to, contentTo, end)) return span;

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
    if (range.empty) return range;

    const constructs = collectConstructs(state, [range.from, range.to]);
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
const createHiddenCheck = (view: EditorView): HiddenCheck => {
    let sets: DecorationSet[] | null = null;
    return ({ from, to }) => {
        sets ??= view.state
            .facet(EditorView.decorations)
            .map((source) => (typeof source === 'function' ? source(view) : source));
        return sets.some((set) => {
            let found = false;
            set.between(from, to, (decoFrom, decoTo, decoration) => {
                if (decoFrom <= from && decoTo >= to && isHidingDecoration(decoration)) {
                    found = true;
                    return false;
                }
                return undefined;
            });
            return found;
        });
    };
};

// Transaction filters don't receive the view, so track views to read their decorations.
const views = new Set<EditorView>();

const viewTracker = ViewPlugin.define((view) => {
    views.add(view);
    return { destroy: () => views.delete(view) };
});

const findView = (state: EditorState): EditorView | undefined => {
    for (const view of views) {
        if (view.state === state) return view;
    }
    return undefined;
};

const selectionFilter = EditorState.transactionFilter.of((tr: Transaction) => {
    if (!tr.selection || tr.docChanged || !tr.isUserEvent('select.pointer')) return tr;

    const view = findView(tr.startState);
    if (!view) return tr;

    const snapped = snapSelection(tr.startState, tr.selection, createHiddenCheck(view));
    if (snapped.eq(tr.selection)) return tr;
    return [tr, { selection: snapped }];
});

export const selectionFixExtension: Extension = [viewTracker, selectionFilter];

export default (): MarkdownEditorContentScriptModule => {
    return {
        plugin: (codeMirrorWrapper: CodeMirrorControl) => {
            if (!codeMirrorWrapper.cm6) return;
            codeMirrorWrapper.addExtension(selectionFixExtension);
        },
    };
};
