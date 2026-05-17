# Add Root-Level Web Test Aliases

## Context

The backlog item under "Frontend Tooling + CI Backlog" asks for root-level
aliases for the existing web test scripts:

- `pnpm web:test`
- `pnpm web:test:watch`
- `pnpm web:test:coverage`
- `pnpm web:test-d`
- `pnpm web:e2e`
- `pnpm web:e2e:headed`

The root `package.json` already exposes web commands such as `web:check`,
`web:build`, and Storybook aliases by delegating through
`corepack pnpm --filter @jobhunter/web ...`. The web package already owns the
target scripts in `apps/web/package.json`: `test`, `test:watch`,
`test:coverage`, `test-d`, `e2e`, and `e2e:headed`.

## Proposed Change

Update the root `package.json` scripts block to add the six missing aliases
using the existing root-script pattern:

```json
"web:test": "corepack pnpm --filter @jobhunter/web test",
"web:test:watch": "corepack pnpm --filter @jobhunter/web test:watch",
"web:test:coverage": "corepack pnpm --filter @jobhunter/web test:coverage",
"web:test-d": "corepack pnpm --filter @jobhunter/web test-d",
"web:e2e": "corepack pnpm --filter @jobhunter/web e2e",
"web:e2e:headed": "corepack pnpm --filter @jobhunter/web e2e:headed"
```

Place them near the existing `web:*` scripts so the root script list remains
scan-friendly.

## Documentation

No new documentation page is needed. Make a narrow update to
`docs/local-development.md` because it currently says the web unit, type-level,
and E2E scripts are not aliased at the repo root. Keep that edit limited to
replacing the stale note and showing the new root aliases.

## Rejected Alternatives

- Add scripts to `apps/web/package.json`: rejected because the scripts already
  exist there; the backlog item is only about root aliases.
- Add a `web:lint` alias: rejected because the same backlog section says there
  is no current ESLint setup or web lint script, and that belongs with the
  separate ESLint backlog item.
- Add CI workflow coverage for the aliases: rejected because CI wiring is a
  separate backlog item and would broaden this scripts-only change.
- Add dependencies or tooling configuration: rejected because delegation to
  existing package scripts requires no dependency changes.

## Verification Plan

Because this is a package-script alias change, the practical validation is to
exercise the new root aliases far enough to prove they resolve to the existing
web package scripts:

- Run `pnpm web:test`.
- Run `pnpm web:test-d`.
- Run `pnpm web:e2e -- --list` to validate Playwright command resolution
  without launching the full browser suite.
- Run `git diff --check`.

Full `web:test:coverage`, `web:test:watch`, and headed E2E execution are not
required for this narrow alias change unless the reviewer asks for exhaustive
manual command coverage; the non-watch aliases validate the same root-to-package
delegation pattern.

## Implementation Notes

- Do not change package dependencies, lockfiles, CI workflows, ESLint setup, or
  unrelated documentation.
- Do not alter the existing `apps/web` scripts.
- Preserve the root repository's existing `corepack pnpm --filter ...` style.
