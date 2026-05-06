# Local Development

JobHunter is a pnpm TypeScript workspace plus a uv-managed Python automation
worker.

## Install

```bash
corepack pnpm install
uv --project workers/automation sync --extra dev
```

## Run

```bash
pnpm api:dev
pnpm web:dev
uv --project workers/automation run jobhunter doctor
```

The Vite web dev server proxies `/v1/*` to the local API by default.

## Verify

```bash
pnpm check
pnpm test
uv --project workers/automation run --extra dev python -m build workers/automation
git diff --check
```

Use focused checks while iterating:

```bash
pnpm api:check
pnpm api:test
pnpm web:check
pnpm web:build
pnpm qa:test
```

## Frontend

The React frontend under `apps/web` follows the architecture documented in
[`docs/frontend-target.md`](frontend-target.md): TanStack Router / Query /
Table / Form on top of shadcn/ui + Tailwind, with an SSE-fed invalidation
router for realtime cache fan-out.

Run the dev server:

```bash
pnpm web:dev
```

Typecheck and build:

```bash
pnpm web:check
pnpm web:build
```

Run the test pyramid (Vitest unit / hook / component, type-level tests, and
Playwright end-to-end). The unit / type / E2E scripts are not aliased at the
repo root yet (tracked in `docs/backlog.md`); run them via `pnpm --filter`
or from the package directory:

```bash
pnpm --filter @jobhunter/web test
pnpm --filter @jobhunter/web test:watch
pnpm --filter @jobhunter/web test:coverage
pnpm --filter @jobhunter/web test-d
pnpm --filter @jobhunter/web e2e
pnpm --filter @jobhunter/web e2e:headed
```

Run Storybook locally and against the built assets:

```bash
pnpm web:storybook
pnpm web:storybook:build
pnpm web:storybook:test
```

`web:storybook:test` runs the Storybook test runner over the static build,
which executes the per-story `play()` interactions and the
`@storybook/addon-a11y` axe checks (critical+serious violations fail).
