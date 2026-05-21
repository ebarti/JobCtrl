# Local Development

JobHunter is a pnpm TypeScript workspace plus a uv-managed Python automation
worker.

## Install

```bash
pnpm dev:setup
```

`pnpm dev:setup` installs the Node workspace dependencies and runs
`uv --project workers/automation sync --extra dev`, which installs the Python
automation worker, `python-jobspy`, JobSpy's locked transitive dependencies, and
the Python dev tools used by local checks.

## Run

```bash
pnpm dev
```

`pnpm dev` starts the full local fleet in dependency order: Temporal dev server,
TypeScript API, Vite web app, and the JobHunter Temporal worker. Before each
component starts, the launcher stops the previous tracked JobHunter process
tree for that component, so rerunning `pnpm dev` starts from a clean owned
stack. It runs in the foreground so supervised terminals keep the child
processes alive; keep the terminal open and stop the stack with Ctrl-C. The
launcher tracks PIDs under `.dev/pids/`, writes logs under `.dev/logs/`, and
defaults to:

- API data dir: `JOBHUNTER_DIR=${HOME}/.jobhunter`
- API bind: `JOBHUNTER_API_HOST=127.0.0.1`,
  `JOBHUNTER_API_PORT=8766`
- Web API base URL: `VITE_JOBHUNTER_API_BASE_URL=http://127.0.0.1:8766`
- Web port: `5173` (`JOBHUNTER_WEB_PORT` can override it)

Inspect the foreground stack from another terminal:

```bash
pnpm dev:status
pnpm dev:logs worker
scripts/dev list
```

For a detached background stack in a normal shell, use the explicit daemon mode:

```bash
pnpm dev:start
pnpm dev:stop
```

Run individual components only when troubleshooting a specific process:

```bash
temporal server start-dev
pnpm api:dev
pnpm web:dev
uv --project workers/automation run jobhunter worker
uv --project workers/automation run jobhunter doctor
```

The Temporal dev server binds the frontend gRPC service on `127.0.0.1:7233` and
the Web UI on `http://127.0.0.1:8233`. With it running, `jobhunter doctor`
reports `Temporal: reachable`. The Vite web dev server proxies `/v1/*` to the
local API by default.

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
