# Local Development

JobHunter is a pnpm TypeScript workspace plus a uv-managed Python worker (a
Temporal worker process that executes workflows). This page is the local loop
end to end: install dependencies, run the full stack, verify a change, and the
frontend, docs-site, and documentation-screenshot workflows.

**Read this if** you are setting JobHunter up on your machine, or you changed
code and need the commands that prove it still works.

## Install

```bash
pnpm install:interactive
```

`pnpm install:interactive` is the first-run path for new contributors. It
checks for Node.js, Corepack, uv, the Temporal CLI, Chrome/Chromium, and Poppler,
offers Homebrew installs for missing machine-level tools when available, then
runs the repository dependency setup: frozen pnpm install, uv sync, and
Playwright Chromium installs for both the web package and the Python worker. It
then runs `jobhunter setup` to detect Claude/Codex/Antigravity auth, persist
enabled analysis legs, and finish with `jobhunter doctor`.

`pnpm install:interactive` accepts `--yes`, `--dry-run`, `--skip-browsers`,
`--skip-system`, and `--skip-doctor` for non-interactive or partial runs.

For machines that already have the system tools and browsers installed, use the
non-interactive dependency sync:

```bash
pnpm dev:setup
```

`pnpm dev:setup` installs the Node workspace dependencies and runs
`uv --project workers/automation sync --extra dev`, which installs the Python
Python worker, `python-jobspy`, JobSpy's locked transitive dependencies, and
the Python dev tools used by local checks. It does not install Temporal,
Chrome/Chromium, Poppler, or Playwright browser binaries.

Run the Python setup command directly when you only need to refresh vendor auth
or analysis-leg configuration:

```bash
uv --project workers/automation run jobhunter setup
uv --project workers/automation run jobhunter setup --non-interactive --json --skip-dependencies --skip-browsers
```

## Run

```bash
pnpm dev
```

`pnpm dev` starts the full local fleet in dependency order: Temporal dev server,
TypeScript API, Vite web app, and the Python worker. Before each
component starts, the launcher stops the existing tracked JobHunter process
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
- Temporal persistence: `.dev/temporal/temporal.db`
  (`JOBHUNTER_TEMPORAL_DB` can override it)

Inspect the foreground stack from another terminal:

```bash
pnpm dev:status
pnpm dev:logs worker
scripts/dev list
```

`pnpm dev:status` combines PID liveness with the API worker heartbeat health
classification. When the worker process is alive but its heartbeat is stale,
the worker row reports `stale` so operator status matches the dashboard.

For a detached background stack in a normal shell, use the explicit daemon mode:

```bash
pnpm dev:start
pnpm dev:stop
```

`pnpm dev:start` prints the observed API, web, and Temporal bindings after the
processes launch. Use the printed web URL rather than assuming `5173`, because
Vite can bind a higher port when another local JobHunter web server is already
using the requested port.

Run individual components only when troubleshooting a specific process:

```bash
temporal server start-dev --db-filename .dev/temporal/temporal.db
pnpm api:dev
pnpm web:dev
uv --project workers/automation run jobhunter worker
uv --project workers/automation run jobhunter doctor
```

The Temporal dev server binds the frontend gRPC service on `127.0.0.1:7233` and
the Web UI on `http://127.0.0.1:8233`. The launcher passes
`--db-filename "$JOBHUNTER_TEMPORAL_DB"` so workflow history persists across
launcher restarts instead of disappearing when the process exits. With Temporal
running, `jobhunter doctor` reports `Temporal: reachable`. The Vite web dev
server proxies `/v1/*` to the TypeScript API by default.

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

Regenerate public documentation screenshots with `pnpm docs:screenshots` — see
[Documentation Screenshots](#documentation-screenshots).

## Frontend

The React frontend under `apps/web` follows the architecture documented in
[`docs/architecture/frontend/`](architecture/frontend/index.md): TanStack Router / Query /
Form on top of shadcn/ui + Tailwind, a shared filterable data grid for
tables, and an SSE-fed invalidation router for realtime cache fan-out.

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
Playwright end-to-end) through the root aliases:

```bash
pnpm web:test
pnpm web:test:watch
pnpm web:test:coverage
pnpm web:test-d
pnpm web:e2e
pnpm web:e2e:headed
```

The package-local commands are equivalent and useful when working directly
inside the web package:

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

## Docs Site

The documentation under `docs/` (minus internal planning docs) is also a
static VitePress site, configured in `docs/.vitepress/config.ts`. The site
publishes the user guide, developer guide, architecture docs, and reference
docs behind a hero landing page (`docs/index.md`); `docs/plans/`,
`docs/incidents/`, `docs/backlog.md`, and the repo-facing `docs/README.md`
map stay repository-only, and links that point at unpublished or repo-root
files are rewritten to GitHub URLs at build time.

```bash
pnpm docs:dev
pnpm docs:build
pnpm docs:preview
```

`pnpm docs:build` fails on dead internal links, then runs
`scripts/check-docs-site-links.mjs`, which fails if any href/src emitted into
the built site does not resolve to a built page or asset (this catches links
to pages relocated by `rewrites`, which VitePress's source-level dead-link
check cannot see). Together they are the docs link-integrity gate; CI runs
them on every pull request that touches `docs/`
(`.github/workflows/docs-site.yml`). Mermaid diagrams render client-side in
the browser, so a build that passes can still contain a diagram that fails to
parse — check edited diagrams in `pnpm docs:dev` before merging. Note that
`pnpm docs:preview` snapshots the built file list at startup: after any
rebuild, restart the preview server or hashed assets will 404. Deploys to
Cloudflare Pages run from `main` once the `DOCS_DEPLOY_ENABLED` repository
variable and the Cloudflare credentials are configured.

## Documentation Screenshots

Public screenshots are generated from synthetic data only — never from a real
`~/.jobhunter` workspace.

```bash
pnpm docs:screenshots
```

The command runs `apps/web/e2e/tests/docs-screenshots.spec.ts` through the
Playwright e2e harness: it seeds a disposable E2E app directory with the local
QA seed (`apps/api/test/qa-seed.ts` — fake candidate, jobs, stage state,
scores, materials, requirement-fit evidence, employer analysis, artifacts, and
a worker heartbeat), starts the API and web app on E2E ports, and writes PNGs
to `docs/assets/screenshots/`. No real LLM provider, job source, Gmail
account, or browser submission is involved.

When running multiple worktrees, override the disposable paths and ports:

```bash
JOBHUNTER_E2E_APP_DIR=/tmp/jobhunter-docs-shots \
JOBHUNTER_E2E_API_PORT=8890 \
JOBHUNTER_E2E_WEB_PORT=5290 \
pnpm docs:screenshots
```

Refresh checklist: run the command on a clean checkout, review every PNG for
private data / broken layout / local-path leaks, confirm the homepage hero copy
at `docs/public/assets/screenshots/dashboard.png` was refreshed from the
gallery dashboard screenshot, update docs if screenshot names changed, and
finish with `git diff --check`.

Safety rules: never point generation at `~/.jobhunter`; never use real
resumes, databases, logs, Gmail tokens, or browser profiles; do not run apply
automation, mailbox scans, real crawling, or real LLM calls for screenshots;
keep output deterministic (fixed viewport, synthetic database, seeded
heartbeat, no external providers).
