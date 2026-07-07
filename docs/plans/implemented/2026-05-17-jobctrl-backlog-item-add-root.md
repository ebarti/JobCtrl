# Add Root-Level Web Test Aliases

## Completion Status

Implemented. The root `package.json` now exposes `web:test`,
`web:test:watch`, `web:test:coverage`, `web:test-d`, `web:e2e`, and
`web:e2e:headed`, each delegating to the matching `@jobhunter/web` script.
The original plan text below is retained as delivery history.

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
surface remains easy to scan. Insert them between `web:preview` and
`web:storybook` so the root script order mirrors the web package's script
order.

## Rejected Alternatives

- Add or change scripts in `apps/web/package.json`: rejected because the
  underlying package scripts already exist and the backlog item asks for
  root-level aliases.
- Add `web:lint`, ESLint config, dependencies, or CI jobs: rejected because
  those are separate backlog items and would broaden this change.
- Modify README or local development docs: rejected for this narrow scripts
  change because the root documentation already references these command
  names; the stale behavior is the missing root aliases. The specific
  completed backlog bullet in `docs/backlog.md` should be removed when the
  aliases land.

## Validation

After editing `package.json`, run the most practical package-manager checks
for this scripts-only change:

1. `corepack pnpm web:test-d` verifies one new root alias delegates correctly
   to the web type-level test script without starting a browser.
2. `corepack pnpm web:test --help` verifies the root unit-test alias reaches
   Vitest without running the full suite if a lighter smoke check is needed.
3. `corepack pnpm web:test:watch --help` verifies the watch alias reaches
   Vitest without entering watch mode.
4. `corepack pnpm web:test:coverage --help` verifies the coverage alias reaches
   Vitest without running the coverage suite.
5. `corepack pnpm web:e2e --help` verifies the Playwright alias reaches
   `playwright test` without launching a browser.
6. `corepack pnpm web:e2e:headed --help` verifies the headed Playwright
   alias delegates correctly without launching a browser.
7. Optionally run `corepack pnpm web:test` when local runtime budget permits.

Do not run headed Playwright as validation for this planning item; the change
only wires aliases, and browser execution belongs to product-flow QA when the
implementation or caller explicitly requires it.

## Implementation Notes

- No commits are needed during the planning phase.
- The implementation phase should keep the functional diff to `package.json`
  and remove only the completed root-alias bullet from `docs/backlog.md`
  unless verification reveals an unexpected script wiring issue.
- Do not pass Jest-only flags such as `--runInBand` to Vitest.
- For root `pnpm` scripts, pass help flags directly, for example
  `corepack pnpm web:e2e --help`; `corepack pnpm web:e2e -- --help` forwards
  `--help` as a Playwright test filter and can start the configured web server.
