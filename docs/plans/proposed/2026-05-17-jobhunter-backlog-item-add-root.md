# Add Root-Level Web Test Aliases

## Goal

Add the missing root `pnpm` aliases for the web test commands named in the
Frontend Tooling + CI Backlog:

- `pnpm web:test`
- `pnpm web:test:watch`
- `pnpm web:test:coverage`
- `pnpm web:test-d`
- `pnpm web:e2e`
- `pnpm web:e2e:headed`

The aliases should make the root command surface match the existing
documentation references while continuing to delegate execution to the
`@jobhunter/web` package.

## Current State

`apps/web/package.json` already owns the underlying scripts:

- `test` -> `vitest run`
- `test:watch` -> `vitest`
- `test:coverage` -> `vitest run --coverage`
- `test-d` -> `vitest run --config vitest.types.config.ts`
- `e2e` -> `playwright test --config=e2e/playwright.config.ts`
- `e2e:headed` -> `playwright test --config=e2e/playwright.config.ts --headed`

The root `package.json` already delegates other web commands through
`corepack pnpm --filter @jobhunter/web <script>` for `web:check`, `web:dev`,
`web:build`, `web:preview`, and Storybook. The backlog item is therefore a
missing alias problem, not a new test-runner or CI integration problem.

## Proposed Change

Update only the root `package.json` scripts block to add:

- `"web:test": "corepack pnpm --filter @jobhunter/web test"`
- `"web:test:watch": "corepack pnpm --filter @jobhunter/web test:watch"`
- `"web:test:coverage": "corepack pnpm --filter @jobhunter/web test:coverage"`
- `"web:test-d": "corepack pnpm --filter @jobhunter/web test-d"`
- `"web:e2e": "corepack pnpm --filter @jobhunter/web e2e"`
- `"web:e2e:headed": "corepack pnpm --filter @jobhunter/web e2e:headed"`

Keep the aliases grouped with the existing root web scripts so the command
surface remains easy to scan.

## Rejected Alternatives

- Add or change scripts in `apps/web/package.json`: rejected because the
  underlying package scripts already exist and the backlog item asks for
  root-level aliases.
- Add `web:lint`, ESLint config, dependencies, or CI jobs: rejected because
  those are separate backlog items and would broaden this change.
- Modify README or local development docs: rejected for this narrow scripts
  change because the root documentation already references these command
  names; the stale behavior is the missing root aliases.

## Validation

After editing `package.json`, run the most practical package-manager checks
for this scripts-only change:

1. `corepack pnpm web:test -- --runInBand` is not appropriate because Vitest
   does not support Jest's `--runInBand`; do not use it.
2. `corepack pnpm web:test-d` verifies one new root alias delegates correctly
   to the web type-level test script without starting a browser.
3. `corepack pnpm web:test -- --help` verifies the root unit-test alias reaches
   Vitest without running the full suite if a lighter smoke check is needed.
4. Optionally run `corepack pnpm web:test` when local runtime budget permits.

Do not run headed Playwright as validation for this planning item; the change
only wires aliases, and browser execution belongs to product-flow QA when the
implementation or caller explicitly requires it.

## Implementation Notes

- No commits are needed during the planning phase.
- The implementation phase should keep the diff to `package.json` unless
  verification reveals an unexpected script wiring issue.
