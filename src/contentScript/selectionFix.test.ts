import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { forceParsing, syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

import { selectionFixExtension } from './selectionFix';

const hiddenMark = Decoration.mark({ class: 'cm-hidden' });

class BulletWidget extends WidgetType {
    public toDOM(): HTMLElement {
        return document.createElement('span');
    }
}

/** Approximates Joplin's render-markup decorations (without reveal logic). */
const fakeJoplinHiding = (state: EditorState): DecorationSet => {
    const ranges: Range<Decoration>[] = [];
    syntaxTree(state).iterate({
        enter: ({ name, from, to, node }) => {
            if (['EmphasisMark', 'StrikethroughMark', 'CodeMark', 'QuoteMark'].includes(name)) {
                ranges.push(hiddenMark.range(from, to));
            } else if (name === 'HeaderMark') {
                const hasSpace = state.sliceDoc(to, to + 1) === ' ';
                ranges.push(hiddenMark.range(from, hasSpace ? to + 1 : to));
            } else if (name === 'LinkMark' || (name === 'URL' && node.parent?.name === 'Link')) {
                ranges.push(hiddenMark.range(from, to));
            } else if (name === 'HTMLTag' && /^<\/?(?:sub|sup|strike|span)(?=[\s>])/i.test(state.sliceDoc(from, to))) {
                ranges.push(hiddenMark.range(from, to));
            } else if (name === 'ListMark' && node.parent?.parent?.name === 'BulletList') {
                ranges.push(Decoration.replace({ widget: new BulletWidget() }).range(from, to));
            }
        },
    });
    return Decoration.set(ranges, true);
};

const createView = (doc: string, hideMarkup = true): EditorView => {
    const view = new EditorView({
        parent: document.body,
        state: EditorState.create({
            doc,
            extensions: [
                markdown({ base: markdownLanguage }),
                hideMarkup ? EditorView.decorations.compute(['doc'], fakeJoplinHiding) : [],
                selectionFixExtension,
            ],
        }),
    });
    forceParsing(view, doc.length);
    return view;
};

const views: EditorView[] = [];
afterEach(() => {
    for (const view of views.splice(0)) view.destroy();
});

/** Dispatches a pointer selection and returns the resulting `[anchor, head]`. */
const select = (
    doc: string,
    anchor: number,
    head: number,
    options: { hideMarkup?: boolean; userEvent?: string } = {}
) => {
    const view = createView(doc, options.hideMarkup);
    views.push(view);
    view.dispatch({
        selection: EditorSelection.single(anchor, head),
        userEvent: options.userEvent ?? 'select.pointer',
    });
    const { anchor: newAnchor, head: newHead } = view.state.selection.main;
    return [newAnchor, newHead];
};

describe('selectionFixExtension', () => {
    describe('bold text', () => {
        const doc = 'This is **bold** text';
        // 'This is ' = 0-8, '**' = 8-10, 'bold' = 10-14, '**' = 14-16, ' text' = 16-21

        it('includes the closing mark when selecting from the start of the line to the end of bold', () => {
            expect(select(doc, 0, 14)).toEqual([0, 16]);
        });

        it('includes the opening mark when selecting backwards from the end of the line', () => {
            expect(select(doc, 21, 10)).toEqual([21, 8]);
        });

        it.each([
            [10, 14],
            [8, 14],
            [10, 16],
            [14, 10],
            [16, 8],
        ])('selects both marks when selecting exactly the bold text (%i-%i)', (anchor, head) => {
            const expected = anchor < head ? [8, 16] : [16, 8];
            expect(select(doc, anchor, head)).toEqual(expected);
        });

        it('drops a dangling closing mark when the content is only partly selected', () => {
            expect(select(doc, 12, 16)).toEqual([12, 14]);
        });

        it('drops a dangling opening mark when the content is only partly selected', () => {
            expect(select(doc, 8, 12)).toEqual([10, 12]);
        });

        it('excludes the opening mark when the selection ends just before the visible bold text', () => {
            expect(select(doc, 0, 10)).toEqual([0, 8]);
        });

        it('excludes the closing mark when the selection starts just after the visible bold text', () => {
            expect(select(doc, 14, 21)).toEqual([16, 21]);
        });

        it('leaves selections that do not touch marks alone', () => {
            expect(select(doc, 11, 13)).toEqual([11, 13]);
            expect(select(doc, 0, 5)).toEqual([0, 5]);
        });

        it('does nothing when markup is not hidden', () => {
            expect(select(doc, 0, 14, { hideMarkup: false })).toEqual([0, 14]);
        });

        it('does nothing for non-pointer selections', () => {
            expect(select(doc, 0, 14, { userEvent: 'select' })).toEqual([0, 14]);
        });
    });

    it('handles nested bold italic', () => {
        const doc = 'a ***both*** b';
        // '***' = 2-5, 'both' = 5-9, '***' = 9-12
        expect(select(doc, 0, 9)).toEqual([0, 12]);
        expect(select(doc, 14, 5)).toEqual([14, 2]);
    });

    it('handles inline code and strikethrough', () => {
        expect(select('x `code` y', 0, 7)).toEqual([0, 8]);
        expect(select('x ~~gone~~ y', 4, 12)).toEqual([2, 12]);
    });

    describe('inline HTML', () => {
        it.each([
            ['<sup>', '</sup>'],
            ['<SUB>', '</sub>'],
            ['<strike>', '</strike>'],
            ['<span style="color: red;">', '</span>'],
        ])('includes both hidden tags around a full selection (%s)', (open, close) => {
            const doc = `x ${open}word${close} y`;
            const start = doc.indexOf('word');
            const end = start + 'word'.length;
            expect(select(doc, start, end)).toEqual([2, end + close.length]);
            expect(select(doc, end, start)).toEqual([end + close.length, 2]);
            expect(select(doc, start, end, { hideMarkup: false })).toEqual([start, end]);
        });

        it('excludes dangling tags from a partial selection', () => {
            const doc = 'x <sup>word</sup> y';
            expect(select(doc, 4, 9)).toEqual([7, 9]);
            expect(select(doc, 9, 14)).toEqual([9, 11]);
        });

        it('pairs nested tags of the same name', () => {
            const doc = 'x <sub>outer <sub>inner</sub> end</sub> y';
            const start = doc.indexOf('inner');
            expect(select(doc, start, start + 5)).toEqual([start - 5, start + 11]);
            expect(select(doc, doc.indexOf('outer'), doc.lastIndexOf('</sub>'))).toEqual([2, doc.length - 2]);
        });

        it('includes hidden HTML tags around a complete Markdown selection', () => {
            const doc = 'x <sup>**bold**</sup> y';
            const start = doc.indexOf('bold');
            expect(select(doc, start, start + 4)).toEqual([2, doc.length - 2]);
        });

        it('pairs a closing tag with an opening tag above both selection endpoints', () => {
            const doc = 'x <sup>first\nsecond</sup> y';
            const close = doc.indexOf('</sup>');
            const start = doc.indexOf('second');
            expect(select(doc, start, close + 2)).toEqual([start, close]);
        });

        it('leaves an unmatched tag alone', () => {
            expect(select('x <sup>word', 4, 11)).toEqual([4, 11]);
        });
    });

    describe('fenced code blocks', () => {
        const doc = 'Intro\n```js\nconst a = 1;\n```\nAfter';
        // '```' = 6-9, 'js' = 9-11, code = 12-24, closing '```' = 25-28

        it('includes the opening fence when dragging from the closing fence to the top', () => {
            expect(select(doc, 28, 9)).toEqual([28, 6]);
            expect(select(doc, 25, 9)).toEqual([28, 6]);
        });

        it('includes both fences when dragging top to bottom', () => {
            expect(select(doc, 9, 25)).toEqual([6, 28]);
        });

        it('handles blocks without a language', () => {
            const plain = '```\ncode\n```';
            expect(select(plain, 12, 3)).toEqual([12, 0]);
            expect(select(plain, 9, 3)).toEqual([12, 0]);
        });

        it('excludes the opening fence from a partial selection of the code', () => {
            expect(select(doc, 18, 6)).toEqual([18, 9]);
        });

        it('leaves unterminated blocks alone', () => {
            expect(select('```js\ncode', 10, 5)).toEqual([10, 5]);
        });
    });

    describe('headings', () => {
        const doc = 'Intro\n## Heading\nAfter';
        // line 2: '## ' = 6-9, 'Heading' = 9-16; line 3 starts at 17

        it('includes the heading mark when selecting from the visible heading start onwards', () => {
            expect(select(doc, 9, 22)).toEqual([6, 22]);
            expect(select(doc, 22, 9)).toEqual([22, 6]);
        });

        it('includes the heading mark when selecting the whole heading text', () => {
            expect(select(doc, 9, 16)).toEqual([6, 16]);
        });

        it('excludes the heading mark from a partial heading selection', () => {
            expect(select(doc, 6, 12)).toEqual([9, 12]);
        });

        it('excludes the heading mark when the selection ends at the visible heading start', () => {
            expect(select(doc, 0, 9)).toEqual([0, 6]);
        });
    });

    it('handles links', () => {
        const doc = 'See [Joplin](https://joplinapp.org) now';
        // '[' = 4-5, 'Joplin' = 5-11, '](https://joplinapp.org)' = 11-35
        expect(select(doc, 0, 11)).toEqual([0, 35]);
        expect(select(doc, 5, 11)).toEqual([4, 35]);
        expect(select(doc, 39, 5)).toEqual([39, 4]);
    });

    it('preserves selection endpoints next to or inside a visible link title', () => {
        const doc = 'See [Joplin](https://joplinapp.org "Website") now';
        const labelEnd = doc.indexOf(']');
        const insideTitle = doc.indexOf('Website') + 3;

        expect(select(doc, 0, labelEnd)).toEqual([0, labelEnd]);
        expect(select(doc, labelEnd, 0)).toEqual([labelEnd, 0]);
        expect(select(doc, 0, insideTitle)).toEqual([0, insideTitle]);
        expect(select(doc, doc.length, insideTitle)).toEqual([doc.length, insideTitle]);
    });

    it('does not extend a link selection across a visible reference label', () => {
        const doc = 'See [Joplin][site]\n\n[site]: https://joplinapp.org';
        const labelEnd = doc.indexOf(']');
        expect(select(doc, 0, labelEnd)).toEqual([0, labelEnd]);
    });

    it('handles bold inside a link', () => {
        const doc = '[**Joplin**](https://joplinapp.org)';
        expect(select(doc, 3, 9)).toEqual([0, doc.length]);
    });

    it('includes a hidden quote mark when the line is covered', () => {
        expect(select('> quoted\nnext', 1, 13)).toEqual([0, 13]);
    });

    it('does not extend past the visible space after a quote mark', () => {
        expect(select('> quoted\nnext', 2, 13)).toEqual([2, 13]);
        expect(select('> quoted\nnext', 13, 2)).toEqual([13, 2]);
    });

    it('does not extend selections to bullet list markers (they are visible widgets)', () => {
        const doc = '## Test list item\n\n- Fix the files one by one.\n';
        const textStart = doc.indexOf('Fix');
        const lineEnd = doc.indexOf('.\n') + 1;
        expect(select(doc, lineEnd, textStart)).toEqual([lineEnd, textStart]);
        expect(select(doc, textStart, lineEnd)).toEqual([textStart, lineEnd]);
        expect(select('> - item\nnext', 4, 13)).toEqual([4, 13]);
    });
});
