## Build, Test, and Development Commands

- `npm run dist` Typecheck, bundle with esbuild, and create archive at `publish/*.jpl`.
- `npm run typecheck` Check TypeScript without producing output.
- `npm test` Run unit tests in jsdom.
- `npm run lint` Lint TypeScript with Oxlint, then run the fallow dead-code and complexity checks.
- `npm run format` Format code with Oxfmt.
- `npm run updateVersion` Increment the patch version in package.json, src/manifest.json, and package-lock.json together.

## Design

- `src/contentScript/selectionFix.ts` registers a transaction filter for `select.pointer` transactions that snaps
  selection endpoints lying inside hidden Markdown marks. "Hidden" is read from the view's live decorations
  (Joplin's `cm-hidden` mark decorations and replace widgets), so revealed markup is never touched.
  Joplin only decorates the viewport, so marks seen hidden during a mouse gesture are remembered until
  the next mousedown, document change, or non-pointer selection change.

## Coding Style & Naming Conventions

- TypeScript with strict settings; 4-space indentation; semicolons required.
- Run `npm run format` before commits.
- Use `src/logger.ts` for log messages.

## Git

- Use conventional commit format for commit messages. Only use "fix" for bugfixes.
- Never run git commit proactively; always wait for explicit user consent.
