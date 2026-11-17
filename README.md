> [!note]
> This plugin was created entirely with AI tools

# Rendered Markup Selection Fix

Fixes mouse selections in Joplin's Markdown editor (with **render markup** enabled) picking up only one half of a pair of hidden formatting characters ([laurent22/joplin#16546](https://github.com/laurent22/joplin/issues/16546)).

## The problem

With render markup enabled, `**bold**` shows as **bold**, and the `**` marks are hidden. The positions on either side of a hidden mark look the same, so a mouse selection can land on either side. When you release the mouse, Joplin reveals the marks and the selection often turns out to be `**bold` or `bold**`, or a heading selection is missing its `#`.

## What it does

While you drag, each selection endpoint that sits inside a hidden mark is snapped:

- If the selection covers the construct's whole visible text, both marks are included (`**bold**`, `# Heading`, `[label](url)`).
- Otherwise the dangling mark is excluded (e.g. selecting part of a bold word never picks up a lone `**`).

The adjustment happens while the marks are still hidden, so the selection looks the same and doesn't jump when the marks are revealed.

Handled: bold/italic (including nested), inline code, strikethrough, highlight (`==`), insert (`++`), links, headings, block quotes, and bullet list markers.

The plugin only adjusts endpoints next to marks that are actually hidden at that moment, so it does nothing when render markup is disabled or the marks are already revealed. Only mouse selections are affected; keyboard selection is unchanged.

## Requirements

- Joplin 3.7 or newer
- Markdown editor (CodeMirror 6) with render markup enabled
