# Local Development

JobCtrl is a pnpm TypeScript workspace plus a uv-managed Python worker (a
Temporal worker process that executes workflows). This page is the local loop
end to end: install dependencies, run the full stack, verify a change, and the
frontend, docs-site, and documentation-screenshot workflows.

**Read this if** you are running or changing a source checkout. These commands
install contributor dependencies and are deliberately different from the
installed product contract. Installed users run `jobctrl start` and plain
`jobctrl <command>` from any directory; they do not use this page's Git, pnpm,
Corepack, uv, or checkout-relative commands.

## Install

```bash
scripts/install
```

`scripts/install` is the first-run path for new contributors. It checks for
Node.js, Corepack, uv, and the Temporal CLI, offers
Homebrew installs for missing machine-level tools when available, then runs the
repository dependency setup: frozen pnpm install, uv sync, and Playwright
Chromium installs for both the web package and the Python worker. This direct
entry point can install a missing standalone Corepack package; once Corepack is
available, `corepack pnpm install:interactive` invokes the same script. It then
runs `jobctrl setup` to detect Claude/Codex/Antigravity auth, persist enabled
analysis legs, and report whether employer analysis is ready. It does not run
`jobctrl doctor` by default because web-first users do not need the CLI profile
created by `jobctrl init`.

`scripts/install` accepts `--yes`, `--dry-run`, `--skip-browsers`,
`--skip-system`, `--skip-doctor`, and `--run-doctor` for non-interactive,
partial, or CLI-diagnostic runs.

`scripts/get` is the transport-only bootstrap boundary for the bundled
distribution; it neither clones a checkout nor provisions contributor tools.
The public installer resolves the authenticated stable release pointer and
delegates installation to the signed native installer. Contributors continue
to use `scripts/install` and the source commands on this page.
`docs/public/install.sh` must stay byte-for-byte identical to `scripts/get`;
`pnpm docs:build` checks that before building the site.

For machines that already have the system tools and browsers installed, use the
non-interactive dependency sync:

```bash
corepack pnpm dev:setup
```

`corepack pnpm dev:setup` installs the Node workspace dependencies and runs
`uv --project workers/automation sync --extra dev`, which installs the Python
worker, the pinned `jobstreaming==0.0.5` provider, its locked transitive
dependencies, and the Python dev tools used by local checks. It does not install Temporal or
Playwright browser binaries. Do not set `UV_EXCLUDE_NEWER` (or a global uv
`exclude-newer` config): it makes uv treat `uv.lock` as needing re-resolution,
so every `--locked` command in this repository fails or, worse, rewrites the
lockfile. System Chrome/Chromium is optional; contributor
testing of apply behavior must explicitly enable a browser capability first.

The source installer downloads separate web/E2E and Python-worker Playwright
Chromium revisions. The bundled release instead contains exactly one
managed Playwright Chromium headless shell for core discovery, enrichment, and
PDF rendering, with no full Chrome/Chromium application. A system browser stays
optional unless an authenticated-browser or auto-apply capability is explicitly
enabled.

Run the Python setup command directly when you only need to refresh vendor auth
or analysis-leg configuration:

```bash
uv --project workers/automation run jobctrl setup
uv --project workers/automation run jobctrl setup --non-interactive --json --skip-dependencies --skip-browsers
```

## Run

```bash
pnpm dev
```

`pnpm dev` is the source-development counterpart of installed
`jobctrl start`. It starts the full local fleet in dependency order: Temporal dev server,
TypeScript API, Vite web app, and the Python worker. Before each
component starts, the launcher stops the existing tracked JobCtrl process
tree for that component, so rerunning `pnpm dev` starts from a clean owned
stack. It runs in the foreground so supervised terminals keep the child
processes alive; keep the terminal open and stop the stack with Ctrl-C. The
launcher tracks PIDs under `.dev/pids/`, writes logs under `.dev/logs/`, and
defaults to:

- API data dir: `JOBCTRL_DIR=${HOME}/.jobctrl`
- API bind: `JOBCTRL_API_HOST=127.0.0.1`,
  `JOBCTRL_API_PORT=8766`
- Web API base URL: `VITE_JOBCTRL_API_BASE_URL=http://127.0.0.1:8766`
- Web port: `5173` (`JOBCTRL_WEB_PORT` can override it)
- Temporal persistence: `$JOBCTRL_DIR/temporal/temporal.db`
  (`JOBCTRL_TEMPORAL_DB` can override it)

`jobctrl.db` and the Temporal history store form one runtime identity. Keeping
both under `JOBCTRL_DIR` lets an interrupted workflow reconnect to the same
history when the source stack is restarted from another Git worktree. To run a
fully isolated stack, give it a separate `JOBCTRL_DIR`; do not point a shared
`jobctrl.db` at a worktree-local Temporal database.

### Runtime Overrides

Use these source-development overrides when troubleshooting a component or
running isolated or multi-worktree stacks. Most contributors can keep the
launcher defaults above.

| Variable                        | Default                     | What it does                                                                                                                                                                                                           |
| ------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JOBCTRL_DIR`                   | `~/.jobctrl`                | Local app directory for database, settings, artifacts, logs, browser worker state, and `.env`.                                                                                                                         |
| `JOBCTRL_DB_PATH`               | `$JOBCTRL_DIR/jobctrl.db`   | TypeScript API database path. The Python worker ignores it and always uses `$JOBCTRL_DIR/jobctrl.db`, so overriding it desynchronizes the API from the worker — prefer `JOBCTRL_DIR` to move both.                     |
| `JOBCTRL_CONFIG_PATH`           | `$JOBCTRL_DIR/config.json`  | Non-secret Settings file written by the TypeScript API and read by both API and worker (general controls, provider metadata, browser adoption, and provider-scoped model IDs). Discovery-page values remain in SQLite. |
| `JOBCTRL_API_HOST`              | `127.0.0.1`                 | Local API bind host. Non-loopback hosts require explicit opt-in.                                                                                                                                                       |
| `JOBCTRL_API_PORT` / `PORT`     | `8766`                      | Local API port.                                                                                                                                                                                                        |
| `JOBCTRL_API_ALLOW_REMOTE_BIND` | unset                       | Set to `1`, `true`, or `yes` to allow non-loopback API binding. This can expose private local data.                                                                                                                    |
| `JOBCTRL_WEB_PORT`              | `5173`                      | Requested Vite development port.                                                                                                                                                                                       |
| `JOBCTRL_DOCS_PORT`             | `4174`                      | Requested VitePress development port.                                                                                                                                                                                  |
| `JOBCTRL_DEMO_WEB_PORT`         | `5174`                      | Requested Vite development port for the browser-local demo.                                                                                                                                                            |
| `JOBCTRL_DEMO_API_PORT`         | `8787`                      | Local Wrangler port for the demo consent and telemetry API.                                                                                                                                                            |
| `JOBCTRL_DEMO_STATE_DIR`        | `.dev/demo/wrangler`        | Local Wrangler/D1 persistence shared by demo migrations and the demo API process.                                                                                                                                      |
| `VITE_JOBCTRL_API_BASE_URL`     | proxied `/v1`               | Browser API origin when not using the default Vite proxy.                                                                                                                                                              |
| `JOBCTRL_TEMPORAL_DB`           | `$JOBCTRL_DIR/temporal/temporal.db` | Temporal (the workflow engine) dev-server SQLite history store. Override it only together with an isolated `JOBCTRL_DIR`; sharing JobCtrl projections while switching Temporal history stores breaks workflow recovery. |
| `TEMPORAL_ADDRESS`              | `localhost:7233`            | Temporal server address used by the worker, CLI, and workflow-starting RPC.                                                                                                                                            |
| `TEMPORAL_NAMESPACE`            | `default`                   | Temporal namespace.                                                                                                                                                                                                    |
| `JOBCTRL_API_SSE_POLL_MS`       | `250`                       | API event-stream database poll interval in milliseconds.                                                                                                                                                               |
| `VITE_DEV_API_PROXY_TARGET`     | `http://127.0.0.1:8766`     | Vite dev-server `/v1` proxy target; override it for isolated or multi-worktree stacks.                                                                                                                                 |
| `VITE_DEMO_API_PROXY_TARGET`    | launcher-managed            | Vite dev-server `/api` proxy target for demo mode. The launcher sets it to the tracked local Wrangler process so consent stays same-origin.                                                                            |
| `VITE_GOOGLE_MAPS_API_KEY`      | unset                       | Enables Google Maps address search in the Profile form.                                                                                                                                                                |

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
Vite can bind a higher port when another local JobCtrl web server is already
using the requested port.

Run individual components only when troubleshooting a specific process:

```bash
temporal server start-dev --db-filename "$JOBCTRL_DIR/temporal/temporal.db"
pnpm api:dev
pnpm web:dev
uv --project workers/automation run jobctrl worker
uv --project workers/automation run jobctrl doctor
```

The Temporal dev server binds the frontend gRPC service on `127.0.0.1:7233` and
the Web UI on `http://127.0.0.1:8233`. The launcher passes
`--db-filename "$JOBCTRL_TEMPORAL_DB"` so workflow history persists across
launcher and worktree restarts instead of disappearing when the process exits.
With Temporal running, `jobctrl doctor` reports `Temporal: reachable`. The Vite
web dev server proxies `/v1/*` to the TypeScript API by default.

### Public demo browser workspace

Run the complete local public demo—synthetic browser-local workspace plus the
real local consent and telemetry Worker—with:

```bash
pnpm demo:dev
```

This is the foreground form: keep the terminal open and press Ctrl-C to stop
both tracked processes. For a detached demo that returns control to the shell,
use the complete lifecycle:

```bash
pnpm demo:start
pnpm demo:status
pnpm demo:stop
```

`pnpm demo:start` applies pending migrations to the local D1 store, starts the
Wrangler API on port `8787`, starts the demo-mode Vite app on requested port
`5174`, prints both observed bindings, and returns. Vite proxies `/api/*` to
Wrangler without changing the browser-facing origin, preserving the same-origin
consent and secure-cookie boundary used in production. Local D1 state persists
under `.dev/demo/wrangler/`; override the three `JOBCTRL_DEMO_*` variables in
the table above for isolated multi-worktree sessions. Inspect process logs with
`pnpm dev:logs demo-api` or `pnpm dev:logs demo-web`.

The local demo does not start the JobCtrl API, Temporal, Python worker, SSE, or
host-OS integrations. Only the exact value `demo` selects this frontend
composition; the lifecycle command supplies it automatically. A missing or
invalid `VITE_JOBCTRL_APP_MODE` keeps the normal local composition, so a
mistyped value cannot produce a partially mounted app.

Demo mode now renders the static acceptance gate before creating IndexedDB.
If the same-origin local Worker is unavailable, acceptance remains fail-closed
and the workspace does not initialize. The local lifecycle runs the real Worker
contract, so it supports manual cookie-persistence testing without a Cloudflare
preview; the dedicated Playwright lane may still stub that contract for focused
frontend tests.

Each browser/storage profile has its own IndexedDB demo workspace. It is not
shared across browser profiles or through a common demo environment, but tabs
and anyone using the same profile can see the same data. Private/incognito
contexts are isolated. Reset rotates the workspace identity, clears pending
demo actions, and deletes generated demo blobs in the same transaction. If
IndexedDB is unavailable or full, the page warns that it has switched to
tab-local memory; those fallback changes are neither shared nor retained after
the tab closes. The demo contains synthetic data, but visitors should still not
enter personal data or secrets. Product reads, filtering, sorting, pagination,
details, bundled previews, and safe synchronous write actions are served from
that browser-local workspace. Those writes are atomic, survive reload, and
remain visible across same-profile tabs. Long-running demo controls, including
the job detail's **run current stage** action, use deterministic queued,
running, and terminal scenarios whose projections survive reload and
same-profile tabs. Application dry-runs, simulated mark-applied actions, and
artifact opening are rehearsals only: each adds a durable receipt that confirms
no external effect occurred. Other provider-backed actions remain unavailable
in the MVP. The receipt history stays inspectable in the demo shell. The demo
never falls back to the product API, SSE, an external origin, or a host-OS
opener.

`DemoSeedValue.seedVersion` is the fixture-revision boundary, separate from the
IndexedDB/workspace schema versions. Changing the canonical seed must bump this
value. When a seed refresh changes the destructive writer contract, also advance
`DEMO_WORKSPACE_SCHEMA_VERSION` so an older bundle refuses the snapshot before
writing or clearing blobs. Only explicitly reviewed older seed versions are
refreshable: on the next initialization they are atomically reseeded with a new
workspace identity and reset epoch, and pending scenarios and generated blobs
are removed. A newer or unknown seed version instead requires an updated demo
and leaves its durable snapshot and blobs untouched. If an allowed durable
refresh cannot be written, the current seed is loaded into tab-local memory with
the existing storage warning. Consent state is outside this workspace lifecycle
and is not reset.

### Public demo edge workers

The public demo uses Cloudflare Pages for the Vite SPA, a same-origin Worker at
`demo.jobctrl.dev/api/*` for consent and telemetry, and an hourly retention
Worker. Run the edge checks with:

```bash
corepack pnpm demo-edge:check
corepack pnpm demo-edge:test
corepack pnpm demo-edge:migrate:local
corepack pnpm demo-edge:dry-run
corepack pnpm demo:build
```

The production Wrangler configs bind the EU-scoped
`jobctrl-demo-telemetry` D1 database. Generated Wrangler bindings are
intentionally ignored—the checked-in environment contract contains only the
four bindings used by this package.

`.github/workflows/demo-site.yml` always builds and verifies the demo. Same-repo
pull requests publish a static Pages preview only when
`DEMO_PREVIEW_DEPLOY_ENABLED=true`. Production runs only from `main` when
`DEMO_DEPLOY_ENABLED=true`, applies D1 migrations, deploys both Workers, and
then publishes Pages. The workflow uses the existing
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` secrets.

The owner-approved open-source sequence does not require paid
private-repository Actions minutes. While the repository is private, zero-step
billing failures are expected and are not validation evidence. First pass the
complete exact-tree local privacy/release gate, then make the repository public
and rerun the hosted workflows on that same `main` SHA. Enable production demo
deployment only after those hosted gates and the demo privacy approvals pass;
see the repository-only [publish checklist](publish-checklist.md).

Rollback the static site from the Cloudflare Pages deployment history, then
redeploy the prior Worker versions if the fault crosses the `/api/*` boundary.
Do not roll D1 backward destructively; migrations are forward-only and the
90-day retention worker remains safe to run during a frontend rollback.
After deployment, `DEMO_BASE_URL=https://demo.jobctrl.dev corepack pnpm
demo:smoke` checks the security headers, a direct SPA deep link, the anonymous
consent read, and exact denied/granted cookie boundary.

## Verify

```bash
pnpm check
pnpm test
uv --project workers/automation run --extra dev python -m build workers/automation
git diff --check
```

Use focused checks while iterating:

```bash
corepack pnpm api:check
corepack pnpm api:test
corepack pnpm web:check
corepack pnpm web:build
corepack pnpm --filter @jobctrl/web e2e:demo-workspace
corepack pnpm scripts:test
corepack pnpm qa:test
corepack pnpm extension:check
corepack pnpm extension:test
corepack pnpm extension:build
corepack pnpm extension:e2e
```

The hermetic broad-board recovery fixture uses local fake adapters and a
time-skipping Temporal test server; it performs no external crawl:

```bash
uv --project workers/automation run pytest -q \
  workers/automation/tests/test_jobstreaming_resumable_discovery.py
```

Regenerate public documentation screenshots with `pnpm docs:screenshots` — see
[Documentation Screenshots](#documentation-screenshots).

## Test And Documentation Workspaces

These contributor-only variables isolate synthetic QA, screenshot generation,
and CI from a real JobCtrl workspace:

| Variable                     | What it does                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `JOBCTRL_E2E_APP_DIR`        | Disposable app directory used by ordinary Playwright e2e. For `docs:screenshots`, an existing temporary parent under which the runner creates its own marker-protected child. |
| `JOBCTRL_E2E_DB_PATH`        | E2E database path.                                                                            |
| `JOBCTRL_E2E_SETTINGS_PATH`  | E2E settings path.                                                                            |
| `JOBCTRL_E2E_API_PORT`       | E2E API port.                                                                                 |
| `JOBCTRL_E2E_WEB_PORT`       | E2E web port.                                                                                 |
| `JOBCTRL_E2E_STUB_DISPATCH`  | Routes selected dispatches through deterministic test stubs.                                  |
| `JOBCTRL_DOCS_SCREENSHOTS`   | Opts the Playwright run into rewriting the synthetic documentation screenshots under `docs/`. |
| `VITE_JOBCTRL_SHOW_DEVTOOLS` | Shows TanStack Router and Query devtools in local Vite dev builds.                            |
| `VITE_JOBCTRL_HIDE_DEVTOOLS` | Compatibility override that hides TanStack devtools even when the show flag is set.           |

Never point these paths at a real `~/.jobctrl` workspace.

## Build the bundled payload

The production-payload builder currently targets Apple-silicon macOS. It is a
release-engineering path, not an alternative contributor setup: the build
machine still needs the source toolchain above plus the pinned `go1.26.4`
launcher compiler, while the resulting payload is self-contained and does not.
The artifact ships only the statically linked launcher and the Go standard
library BSD-3-Clause attribution — never the compiler.

```bash
pnpm distribution:audit
pnpm distribution:build
```

`pnpm distribution:audit` checks the component inventory, redistribution and
license policy, exact external archive locks, provider-pack wheel locks, source
dependency baseline, and signing policy. `pnpm distribution:build` writes an
unsigned local payload and deterministic ZIP archive under
`dist/distribution-real/`. The build compiles the API and web app, installs the
core-only Python closure, embeds the pinned Node, Temporal, Python Playwright,
Playwright MCP, and Chromium runtimes, then emits the manifest, SBOM,
attributions, provenance, and component-size evidence. It fails if a
development tool, provider runtime, source path, unowned file, unresolved
license, or unpinned external input enters the payload.

The local artifact is deliberately marked `unsigned-local` and cannot be
promoted as a stable release. It includes both native binaries at
`payload/launcher/jobctrl` and `payload/launcher/jobctrl-installer`, compiled
with the locked official Go toolchain. Its local descriptor, detached
unsigned-local envelope, and curl fixture contract bind the ZIP's build ID,
manifest SHA-256, size, archive SHA-256, an explicit minimum-safe sequence
(`0` locally), and an explicit empty revocation list; those fixtures are
file-only and cannot select a network channel. Signed stable/prerelease
descriptors use the same canonical fields with a positive floor and sorted,
unique revocation tombstones. The launcher's private runtime manifest starts the fixed
loopback Temporal (`7233`/`8233`), worker, and API (`8766`) fleet without Vite,
and records each canonical `JOBCTRL_DIR` under
`~/Library/Application Support/JobCtrl/instances/<sha256>` (override with
`JOBCTRL_RUNTIME_HOME`). This is an artifact smoke/development surface only;
`scripts/dev` remains the source-contributor launcher until the installer and
signing phases land. Use the much smaller contract fixture while changing the
builder itself:

```bash
pnpm distribution:build:fixture
pnpm distribution:provider-lock:check
```

Provider SDKs and their proprietary companion runtimes are not copied into the
core archive. Their complete transitive wheel closures are generated from the
Python lock and acquired later as isolated, hash-verified official-channel
packs. Ordinary source `uv sync` and `uv run` retain the existing provider
ensemble through the default `provider-runtime` dependency group; the payload
builder explicitly selects `--no-default-groups --no-dev`.

## First-Run TTFV Measurement

Real-path first-run time-to-value measurement is owner-run only because it uses
real vendor auth, real discovery from the owner's target search settings, real
job output, and real LLM spend. The wrapper lives at `scripts/ttfv-real.mjs`
and is exposed through:

```bash
pnpm ttfv:real
pnpm ttfv:probe
pnpm ttfv:summary -- "$HOME/.jobctrl/measurements/ttfv-real-run-"*.json
```

Use `node scripts/ttfv-real.mjs run ...` directly on a clean checkout before
dependencies are installed; the wrapper records T0 immediately before it starts
`scripts/install`, captures a pre-work `/v1/jobs` baseline,
across all job visibility states, and starts the real path with
`jobctrl run discover score tailor --limit 1 --workers 1`. The summary gate
accepts only full clean-run records with all-state baseline absence,
`discoveredAt >= T0`, hashed real discovery-source proof, plus same-job
API/UI/PDF proof; probe-only, seeded, and timing-only records are rejected. See
[`developer/first-run-ttfv.md`](developer/first-run-ttfv.md) for the clean-run
protocol, stop conditions, record privacy rules, and three-run summary command.

## Frontend

The React frontend under `apps/web` follows the architecture documented in
[`docs/architecture/frontend/`](architecture/frontend/index.md): TanStack Router / Query /
Form on top of the shadcn Rhea preset, Base UI behavior primitives, and
Tailwind CSS v4, with a shared filterable data grid for tables and an SSE-fed
invalidation router for realtime cache fan-out. Shared wrappers under
`apps/web/src/shared/ui/` own primitive behavior and appearance; route code
must not import Radix directly or replace an accessible wrapper with a raw
native lookalike.

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
pnpm --filter @jobctrl/web test
pnpm --filter @jobctrl/web test:watch
pnpm --filter @jobctrl/web test:coverage
pnpm --filter @jobctrl/web test-d
pnpm --filter @jobctrl/web e2e
pnpm --filter @jobctrl/web e2e:headed
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

## Browser Extension

The Manifest V3 browser extension lives under `apps/extension`. It is the local
capture/autofill client and integrated-Discovery browser transport for the
TypeScript API, not a hosted/browser-store package.

```bash
corepack pnpm extension:check
corepack pnpm extension:test
corepack pnpm extension:build
corepack pnpm extension:e2e
```

`corepack pnpm extension:build` writes the unpacked extension bundle to
`dist/extension/`; load that directory in Chrome/Chromium developer mode for
manual QA, or reload its existing unpacked-extension card after rebuilding.
Reload any application tabs that were already open so Chrome injects the newly
built content script into them.
Chrome can otherwise load the rebuilt popup from disk while retaining the old
background service worker. The popup validates their shared message protocol,
reports **Extension update incomplete**, and disables pairing/actions instead
of rendering missing fields or claiming readiness. Reload the unpacked
extension card to make both halves use the same build.
The content script matches `http://*/*` and `https://*/*`, which Chrome presents
as access to all ordinary web sites; browser-internal and extension pages remain
outside that match. Autofill stays passive until an explicit extension action;
the background service worker also polls for bounded Discovery tasks and
executes HTTP/API work in the service worker and rendered-page work in temporary
inactive tabs in the profile where the extension is loaded. Saving the token in
that popup explicitly selects its extension-local installation UUID for
Discovery; merely retaining an older token does not win a race with another
Chrome profile. The extension uses `activeTab`, `alarms`,
`declarativeNetRequest`, `scripting`, and `storage`; HTTP(S) page and network
access are wildcarded because the broker can lease arbitrary configured public
job sources. Capture/autofill API traffic remains loopback-only, and remote
service-worker requests exist only for active Discovery leases.
`corepack pnpm extension:e2e` builds the bundle and proves wildcard page reach,
the generic-form review path, loopback-only capture/autofill traffic, and a
synthetic Discovery API lease completed from a non-HTML source origin with a
cookie set in that same persistent Chrome context. It also proves a hanging
request hard-times out without leaving a tab and that a public source redirect
cannot reach a loopback target. After every rebuild, reload the installed extension before using its
selected-installation heartbeat as product-path evidence. A current popup with
an already stored token reports whether this exact installation is selected and
offers **Use this Chrome profile for Discovery**, so recovery does not require
copying the token again.

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
pnpm docs:check:runtime
pnpm docs:preview
```

`pnpm docs:dev` is the foreground server and stops with Ctrl-C. For a tracked
background server that returns control to the shell, use:

```bash
pnpm docs:start
pnpm docs:status
pnpm docs:stop
```

`pnpm docs:start` prints the observed VitePress URL (requested port `4174`) and
returns. Use that URL because VitePress may select a higher port when the
requested one is occupied. Its PID and log use the shared `.dev/` launcher
state; inspect the log with `pnpm dev:logs docs`.

`pnpm docs:build` fails on dead internal links, then runs
`scripts/check-docs-site-links.mjs`, which fails if any href/src emitted into
the built site does not resolve to a built page or asset (this catches links
to pages relocated by `rewrites`, which VitePress's source-level dead-link
check cannot see). Together they are the docs link-integrity gate; CI runs
them on pushes to `main`, and maintainers can run the docs workflow manually for
pull requests after review.
(`.github/workflows/docs-site.yml`). Mermaid diagrams render client-side in
the browser, so a build that passes can still contain a diagram that fails to
parse. `pnpm docs:check:runtime` starts a fresh preview and checks hydration,
images, navigation, responsive diagrams, search, the comparison screenshot-carousel
interaction, and the desktop/mobile comparison layout (including keyboard access to
its wide table) in Chromium. It also intercepts the Google tag and proves the
documentation cookie banner makes no analytics request before acceptance,
persists both choices, emits SPA page views only after acceptance, and stops
tracking plus clears site analytics cookies after withdrawal;
run it after `pnpm docs:build` for public-doc changes. Note that
`pnpm docs:preview` snapshots the built file list at startup: after any
rebuild, restart the preview server or hashed assets will 404. Deploys to
Cloudflare Pages run from `main` once the `DOCS_DEPLOY_ENABLED` repository
variable and the Cloudflare credentials are configured.

The docs theme sends its own sanitized `page_view` for the initial accepted
route and each VitePress navigation. In the GA4 web data stream for
`G-KB495KG6MS`, keep **Enhanced measurement → Page views → Page changes based
on browser history events** disabled. The tag's `send_page_view: false`
setting suppresses only its automatic load-time view; leaving GA4's separate
history listener enabled would double-count client-side navigations. The
repository runtime check stubs Google and proves the manual client contract;
the matching data-stream setting and live event count are owner-side
deployment checks.

## Documentation Screenshots

Public screenshots are generated from synthetic data only — never from a real
`~/.jobctrl` workspace.

```bash
pnpm docs:screenshots
```

The command runs `apps/web/e2e/tests/docs-screenshots.spec.ts` through the
Playwright e2e harness: it seeds a disposable E2E app directory with the local
QA seed (`apps/api/test/qa-seed.ts` — fake candidate, jobs, stage state,
scores, materials, requirement-fit evidence, employer analysis, artifacts,
pipeline-operations lineage/projections/ETA samples, and a current worker
heartbeat), starts the API and web app on E2E ports, and writes PNGs to
`docs/assets/screenshots/`. The manifest covers all production primary routes,
detail workspaces, profile-import steps, Settings routes, and fixed mobile
companions. The internal capture manifest lives in
`apps/web/e2e/tests/docs-screenshots.spec.ts`; it is not part of the public
Product Tour. No real LLM provider, job source, Gmail account, or browser
submission is involved.

The spec is opt-in: it only writes when `JOBCTRL_DOCS_SCREENSHOTS=1` is set,
which `pnpm docs:screenshots` does for you. A bare full e2e run
(`pnpm --filter @jobctrl/web e2e`) skips it, so QA runs never rewrite the
committed screenshots.

The wrapper allocates isolated ports and a marker-owned temporary workspace by
default. To pin them while running multiple worktrees, create a disposable
temporary parent and override the parent and ports:

```bash
mkdir -p /tmp/jobctrl-docs-shots
JOBCTRL_E2E_APP_DIR=/tmp/jobctrl-docs-shots \
JOBCTRL_E2E_API_PORT=8890 \
JOBCTRL_E2E_WEB_PORT=5290 \
pnpm docs:screenshots
```

Refresh checklist: run the command on a clean checkout, confirm every asset in
the internal capture manifest was rewritten, review every desktop and mobile
PNG for private data, broken layout, clipped content, and local-path leaks, and
inspect Pipelines for the seeded execution, three source families, two
reconciliation steps, available worker capacity, visual stage flow,
stop/recovery controls, and active work. Confirm Jobs shows only the
Active/Deleted/Hidden queue tabs and that Sources/Warnings remain hidden in its
default view. Check Apply Review's left queue plus sequential review content,
Artifact Detail's preview after its audit details, and the mobile
Profile/Evidence/record-card reflows without horizontal overflow. Keep raw IDs
and paths inside technical disclosures. Open the rendered Product Tour and
confirm it contains only user-facing product explanations and screenshots—not
the asset manifest, capture commands, or viewport QA criteria. Confirm the
homepage hero copy at `docs/public/assets/screenshots/dashboard.png` is
byte-for-byte identical to the gallery dashboard screenshot, update the tour
if screenshot names changed, and finish with `git diff --check`.

Safety rules: never point generation at `~/.jobctrl` or a shared temporary
root; an override must name an existing disposable child directory that the
runner can use only as a parent for its unique marker-owned workspace. Never use real
resumes, databases, logs, Gmail tokens, or browser profiles; do not run apply
automation, mailbox scans, real crawling, or real LLM calls for screenshots;
keep output deterministic (fixed per-surface viewports, synthetic database,
seeded pipeline operations and heartbeat, no external providers).
The Profile preview renderer runs with the Python lock held; its fixed dependency
cutoff is defined in `workers/automation/pyproject.toml`, not inherited from a
caller-provided `UV_EXCLUDE_NEWER` value. A stale lock must fail rather than
being rewritten by screenshot generation.

### Launch Demo Asset Inventory

The launch demo assets each prove one product invariant from synthetic data.
Each asset is classified **A** (static, already covered), **B** (static, new seed
state), or **C** (dynamic/lifecycle — a driven flow that is _defined_ here, not
executed by CI), and maps to a `Current` row in the repository-only claims ledger
(`docs/claims-ledger.md`), which is the committed source of truth for every claim
below.

| #   | Asset                                                                   | Class | Claim(s)                               | Regeneration / proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Status                                                                                          |
| --- | ----------------------------------------------------------------------- | ----- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | First run → empty dashboard                                             | B     | `CL-060`, `CL-072`                     | Empty-workspace seed variant + a `docs-screenshots.spec.ts` onboarding surface                                                                                                                                                                                                                                                                                                                                                                                                              | Deferred — needs an empty-workspace seed variant + capture surface                              |
| 2   | Resume / profile import                                                 | B/C   | `CL-080`                               | `pnpm docs:screenshots` → `profile-import-upload.png`, `profile-import-preview.png`, `profile-import-confirm.png`; actual import remains a separately driven lifecycle                                                                                                                                                                                                                                                                                                                      | Static wizard Covered; import mutation lifecycle Defined (class C)                              |
| 3   | Discovery → scored jobs + requirement fit + provenance                  | A     | `CL-001`, `CL-010`, `CL-011`, `CL-020` | `pnpm docs:screenshots` → `jobs.png`, `job-detail.png` (seed: scored job, `job_requirement_fit_items`, `job_bullet_provenance`)                                                                                                                                                                                                                                                                                                                                                             | Covered                                                                                         |
| 4   | Apply-review audit surfaces                                             | A     | `CL-023`, `CL-024`, `CL-030`           | `pnpm docs:screenshots` → `apply-review.png` (seed: approved generation, evidence, `change_annotations`)                                                                                                                                                                                                                                                                                                                                                                                    | Covered                                                                                         |
| 5   | Failed refresh preserves last accepted artifact                         | B     | `CL-025`                               | Regression tests `apps/api/test/resume-templates.test.ts` ("keeps the last accepted resume artifact when the PDF render fails"; "reports refresh unavailable without hiding the last accepted artifact") and `apps/api/test/resume-review-drafts.test.ts` ("fails the render and preserves prior approved artifacts …"); run `pnpm api:test`                                                                                                                                                | Covered — invariant proven from fixture                                                         |
| 6   | Tailoring gate rejects an unsupported claim                             | B     | `CL-021`                               | Grounding-gate regression `workers/automation/tests/test_claim_grounding.py` (a claim whose text is absent from the shipped resume is flagged `ungrounded` with an inspectable reason — the CL-021 fail-closed behaviour) and `workers/automation/tests/test_coverage_audit.py` (fabricated/stuffed keywords fall into `missing`); the apply-review rendering of the resulting blocker is seeded in `apps/api/test/qa-seed.ts` and asserted by `apps/api/test/application-feedback.test.ts` | Covered — gate + surface proven from fixtures                                                   |
| 7   | Dry-run apply completes + live-approval gate + blocked-channel evidence | B / C | `CL-030`–`CL-034`                      | Approval card + dry-run run (`qa-run-1`) via `pnpm docs:screenshots`; live blocked-channel evidence via a driven dry-run (capability shipped: approval binding + dry-run evidence)                                                                                                                                                                                                                                                                                                          | Approval card + dry-run run Covered; live blocked-channel evidence Defined (class C)            |
| 8   | Spend-ceiling stop + health surface                                     | B / C | `CL-040`, `CL-041`                     | Health surface with an `llm_spend`-at/over-budget seed fixture + capture; stop lifecycle via a driven run (spend ceiling shipped)                                                                                                                                                                                                                                                                                                                                                           | Deferred — needs an `llm_spend` seed fixture + health capture; stop lifecycle Defined (class C) |
| 9   | Reliability demo — kill worker, restart, resume                         | C     | `CL-050` (`TR-008`)                    | `scripts/reliability-demo.sh` drives `DurabilityProbeWorkflow` (a hermetic durable-timer probe — no crawl/LLM) on an isolated stack; kills the worker by captured PID tree and asserts the same run ids resume in Temporal + the read-model projection. Probe covered by `workers/automation/tests/test_workflow_durability_probe.py`; see [Reliability & QA → Durable-Execution Recovery Demo](local-reliability-qa.md#durable-execution-recovery-demo)                                    | Defined — self-asserting, re-runnable script (verified locally)                                 |

Deferred static assets (1 and 8 health capture) are launch-set follow-ups: they
need a new synthetic seed variant or capture surface, not a missing product
capability. Class-C assets (2 actual import mutation, 7 live evidence, 8 stop
lifecycle, 9) are defined driven flows, never faked with a staged static image.
No asset regenerates from a real workspace.
