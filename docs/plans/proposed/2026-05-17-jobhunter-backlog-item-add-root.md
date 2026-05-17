# Add Root-Level Web Test Aliases

## Status

Proposed, planning round 1.

## Goal

Add root-level pnpm aliases for the existing `@jobhunter/web` test scripts so
the commands referenced by the frontend migration docs work from the repository
root:

- `pnpm web:test`
- `pnpm web:test:watch`
- `pnpm web:test:coverage`
- `pnpm web:test-d`
- `pnpm web:e2e`
- `pnpm web:e2e:headed`

The backlog source is `Frontend Tooling + CI Backlog` in `docs/backlog.md` from
the main JobHunter checkout. It states that Phase 6 added the scripts only in
`apps/web/package.json`; root aliases are still missing.

## Current State

The root `package.json` already exposes web development, build, preview, and
Storybook scripts using the repository convention:

```json
"web:build": "corepack pnpm --filter @jobhunter/web build"
```

The web package already owns the target scripts:

```json
"test": "vitest run",
"test:watch": "vitest",
"test:coverage": "vitest run --coverage",
"test-d": "vitest run --config vitest.types.config.ts",
"e2e": "playwright test --config=e2e/playwright.config.ts",
"e2e:headed": "playwright test --config=e2e/playwright.config.ts --headed"
```

No new test runner, dependency, or CI wiring is needed for this backlog item.

## Proposed Change

Update only the root `package.json` `scripts` object by adding aliases that
delegate to the existing `@jobhunter/web` scripts:

```json
"web:test": "corepack pnpm --filter @jobhunter/web test",
"web:test:watch": "corepack pnpm --filter @jobhunter/web test:watch",
"web:test:coverage": "corepack pnpm --filter @jobhunter/web test:coverage",
"web:test-d": "corepack pnpm --filter @jobhunter/web test-d",
"web:e2e": "corepack pnpm --filter @jobhunter/web e2e",
"web:e2e:headed": "corepack pnpm --filter @jobhunter/web e2e:headed"
```

Place the new scripts near the existing root `web:*` scripts so the script list
remains discoverable and grouped by surface.

## Rejected Alternatives

- Add ESLint, dependency-cruiser, or CI grep guards: those are separate backlog
  items and would broaden a scripts-only change.
- Run web tests directly from the root scripts, for example
  `vitest run --dir apps/web`: this would duplicate implementation details and
  risk drift from the package-owned scripts.
- Add or rename scripts in `apps/web/package.json`: the needed script names
  already exist there.
- Update broad documentation: the root aliases are already referenced by the
  frontend migration documentation, and this change makes those references true.
  The package script metadata is the owning surface for this implementation.

## Validation Plan

After editing `package.json`, run practical package-manager validation for a
scripts-only change:

1. Run `corepack pnpm run` and confirm the six new root scripts are listed.
2. Run `corepack pnpm web:test` when dependencies are available. This exercises
   the most common alias and the existing web unit test command.
3. Run `corepack pnpm web:test-d` when type-level validation is practical.
4. For the Playwright aliases, prefer command-resolution validation such as
   `corepack pnpm web:e2e -- --help` unless a browser QA pass is specifically
   requested.

The implementation phase should report any validation command that cannot run,
including missing dependencies or Playwright browser prerequisites. E2E aliases
can be validated by script resolution rather than executing the whole browser
suite unless the reviewer requests a product-level browser QA pass.

## Acceptance Criteria

- Root `package.json` includes all six requested aliases.
- Each alias delegates to the matching existing `@jobhunter/web` script through
  `corepack pnpm --filter @jobhunter/web ...`.
- No unrelated package scripts, dependencies, CI files, or documentation are
  changed.
- Relevant package-manager validation has been run and reported.
