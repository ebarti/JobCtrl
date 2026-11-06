# Local Development

JobCtrl uses a Python application and Temporal worker, a TypeScript/React web
client, and a browser extension. This page covers source setup, running the
local stack, and verifying changes. The Python transformation is in progress;
source behavior and synthetic proof do not establish a published release.

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
Node.js 22.13 or newer, Corepack, uv (the Python worker needs Python 3.11 or
newer), the Temporal CLI, and Go 1.24 or newer on macOS, offers
Homebrew installs for missing machine-level tools when available, then runs the
repository dependency setup: frozen corepack pnpm install, uv sync, and Playwright
Chromium installs for both the web package and the Python worker. This direct
entry point can install a missing standalone Corepack package; once Corepack is
available, `corepack pnpm install:interactive` invokes the same script. It then
runs the Python application's `jobctrl setup` to report provider readiness and
guide explicit credential and live-model selection. Interactive Claude and
Google API keys go to the native operating-system credential store; provider
and model choices use the canonical application settings. It skips the final
`jobctrl doctor` by default. `jobctrl init` initializes a fresh target workspace
and points to the Profile authoring/import, Discovery and provider setup flows;
it does not replace an existing Profile or search configuration.

`scripts/install` accepts `--yes`, `--dry-run`, `--skip-browsers`,
`--skip-system`, `--skip-doctor`, and `--run-doctor` for non-interactive,
partial, or CLI-diagnostic runs.

`scripts/get` is the transport-only bootstrap boundary for the bundled
distribution; it neither clones a checkout nor provisions contributor tools.
The public installer resolves the authenticated stable release pointer and
delegates installation to the signed native installer. Contributors continue
to use `scripts/install` and the source commands on this page.
`docs/public/install.sh` must stay byte-for-byte identical to `scripts/get`;
`corepack pnpm docs:build` checks that before building the site.

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
Install the locked Python browser revision with
`uv --project workers/automation run --locked --all-extras playwright install chromium`
when it is needed for rendering or browser journeys. Use only owned synthetic
workspaces and controlled external boundaries for verification.

The source installer downloads separate web/E2E and Python-worker Playwright
Chromium revisions. The bundled release instead contains exactly one
managed Playwright Chromium headless shell for core discovery, enrichment, and
PDF rendering, with no full Chrome/Chromium application. A system browser stays
optional unless an authenticated-browser or auto-apply capability is explicitly
enabled.

Run the Python setup command directly when you only need to inspect provider
readiness or explicitly configure credentials and model selection:

```bash
uv --project workers/automation run --no-sync python -m jobctrl setup
uv --project workers/automation run --no-sync python -m jobctrl setup --non-interactive --json
```

`setup --dry-run` reports intended actions without creating a workspace or
writing settings or credentials. `--yes` and `--non-interactive` never prompt
for a secret. `setup --provider codex --launch-logins` is an explicit request
for the managed Codex vendor login; ordinary readiness checks do not launch it.
Source dependency provisioning remains in `scripts/install` and
`corepack pnpm dev:setup`. Browser installation uses `scripts/install` or the
explicit pinned Playwright command above, outside provider setup.

## Run

<a id="native-credential-migration"></a>

### Native credentials

Use `jobctrl setup` or **Settings → Credentials** to inspect provider readiness
and explicitly manage credentials. See [Configuration](user/configuration.md)
for credential sources and precedence. The launcher may inherit environment
values, so a separate workspace directory alone does not isolate credentials;
never use personal credentials for QA.

### Start the development stack

```bash
corepack pnpm dev
```

The source launcher builds the browser extension, then starts Temporal, the
Python HTTP application, the Vite web app and the Python worker. It runs in the
foreground: keep the terminal open and stop the stack with Ctrl-C. It tracks
process ownership under `.dev/pids/` and logs under `.dev/logs/`. On macOS,
the source fleet shares workspace ownership controls with a compatible installed
application. An unverified process or an unexpected listener is not authority
to stop or replace it.

The default workspace is `~/.jobctrl`, the API is loopback-only on
`127.0.0.1:8766`, and Vite requests port `5173`. Use the printed URL if Vite
chooses a different port. New workspaces use `$JOBCTRL_DIR/temporal.db`; keep
application and Temporal state together for recovery. A responding API probe
alone does not establish that every writer or descendant has stopped. Inspect
ownership, listener and process state independently before changing the runtime.

For a detached stack, use `corepack pnpm dev:start`; inspect it with
`corepack pnpm dev:status` and stop its owned processes with
`corepack pnpm dev:stop`.

<a id="schema-migrations-and-source-updates"></a>

### Workspace compatibility and source updates

The Python application does not upgrade the previous application database in
place. It refuses a legacy workspace before opening its database with SQLite;
this applies to source startup across platforms. Preserve the existing workspace
and its history. Starting a checkout, updating source dependencies or an
installed release does not authorize a reset.

The deliberate transition uses `jobctrl profile-transfer` with a read-only
source, a nonexistent target outside the source, a complete browser Profile
sources and attachment manifest, and explicit `--confirm-profile-only-reset`.
It preserves the full Profile, supporting sources, confirmations, preferences
and provenance; other application data starts fresh in the new workspace. The
command leaves the source and workspace selection unchanged. Review the receipt
and select the new workspace deliberately after verification. Installed cutover
also requires a separate fresh native runtime home with no active selection; an
existing installation's runtime home cannot adopt the incomplete database pair.
First native selection consumes the transfer permission once. Preserve both old
locations and inspect an interrupted selection rather than clearing its marker.
See
[Getting Started](user/getting-started.md#update-roll-back-or-remove-jobctrl)
for the release boundary. A one-off Profile transfer integrity proof uses owned
synthetic data; development and QA never reset a real user's workspace.

For source updates, stop the owned stack, preserve unrelated work, update the
checkout and dependencies, and restart only after checking workspace
compatibility. Updating a checkout does not publish or update an installed
release. For ordinary development that does not need personal data, use a
separate owned synthetic `JOBCTRL_DIR`, with synthetic credentials and sources;
setting that path alone does not isolate inherited environment credentials.

### Runtime Overrides

These source-development overrides are useful for separate local stacks. The
Python HTTP application accepts only loopback binds.

| Variable | Default | Purpose |
| --- | --- | --- |
| `JOBCTRL_DIR` | `~/.jobctrl` | Workspace for application data and artifacts. Use a separate owned synthetic path for QA. |
| `JOBCTRL_API_HOST` | `127.0.0.1` | Loopback API bind host. |
| `JOBCTRL_API_PORT` | `8766` | API port. |
| `JOBCTRL_WEB_PORT` | `5173` | Requested Vite port. |
| `JOBCTRL_DOCS_PORT` | `4174` | Requested VitePress port. |
| `JOBCTRL_DEMO_WEB_PORT` | `5174` | Requested browser-local demo port. |
| `JOBCTRL_DEMO_API_PORT` | `8787` | Local demo Worker port. |
| `JOBCTRL_DEMO_STATE_DIR` | `.dev/demo/wrangler` | Local demo Worker persistence. |
| `VITE_JOBCTRL_API_BASE_URL` | Launcher-selected API URL | Browser API origin for the source stack. |
| `VITE_DEV_API_PROXY_TARGET` | `http://127.0.0.1:8766` | Vite `/v1` proxy target. |
| `JOBCTRL_TEMPORAL_DB` | `$JOBCTRL_DIR/temporal.db` for a new workspace | Temporal development-server history. Keep it paired with the application workspace. |
| `JOBCTRL_TEMPORAL_ADDRESS` | `127.0.0.1:7233` | Temporal address used by the application and worker. |
| `JOBCTRL_TEMPORAL_NAMESPACE` | `default` | Temporal namespace used by the application and worker. |
| `VITE_GOOGLE_MAPS_API_KEY` | unset | Enables Google Maps address search in the Profile form. |

Inspect the stack from another terminal:

```bash
corepack pnpm dev:status
corepack pnpm dev:logs worker
scripts/dev list
```

Ownership and health are distinct: an unknown health result does not prove a
process is down, and a PID alone does not authorize signaling it. Preserve
unverified records and inspect listeners and processes independently before
starting a replacement. `scripts/dev forget` retires only explicitly named,
unverified source-launch metadata; it does not stop a process or prove it has
exited.

Run an individual component only when troubleshooting its process:

```bash
corepack pnpm api:dev
corepack pnpm web:dev
corepack pnpm worker:start
uv --project workers/automation run --no-sync python -m jobctrl doctor
```

The API and worker need the intended workspace and Temporal configuration; the
launcher normally supplies them. The web development proxy targets the Python
HTTP application. Do not run destructive database maintenance or a real-user
reset for development or QA.

### Public demo browser workspace

Run the complete local public demo—synthetic browser-local workspace plus the
real local consent and telemetry Worker—with:

```bash
corepack pnpm demo:dev
```

This is the foreground form: keep the terminal open and press Ctrl-C to stop
both tracked processes. For a detached demo that returns control to the shell,
use the complete lifecycle:

```bash
corepack pnpm demo:start
corepack pnpm demo:status
corepack pnpm demo:stop
```

`corepack pnpm demo:start` applies pending migrations to the local D1 store, starts the
Wrangler API on port `8787`, starts the demo-mode Vite app on requested port
`5174`, prints both observed bindings, and returns. Vite proxies `/api/*` to
Wrangler without changing the browser-facing origin, preserving the same-origin
consent and secure-cookie boundary used in production. Local D1 state persists
under `.dev/demo/wrangler/`; override the three `JOBCTRL_DEMO_*` variables in
the table above for isolated multi-worktree sessions. Inspect process logs with
`corepack pnpm dev:logs demo-api` or `corepack pnpm dev:logs demo-web`.

The local demo does not start the JobCtrl API, Temporal, Python worker, SSE, or
host-OS integrations. Only the exact value `demo` selects this frontend
composition; the lifecycle command supplies it automatically. A missing or
invalid `VITE_JOBCTRL_APP_MODE` keeps the normal local composition, so a
mistyped value cannot produce a partially mounted app.

Demo mode now renders the static acceptance gate before creating IndexedDB.
If the same-origin local Worker is unavailable, acceptance remains fail-closed
and the workspace does not initialize. The local lifecycle runs the real Worker
contract, so it supports manual cookie-persistence testing without a Cloudflare
preview. The recurring application journeys use real internal services; see
[Python Application Journeys](developer/qa/python-journeys.md).

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
Worker. Local demo tooling includes:

```bash
corepack pnpm demo-edge:check
corepack pnpm demo-edge:migrate:local
corepack pnpm demo-edge:dry-run
corepack pnpm demo:build
```

The production Wrangler configs bind the EU-scoped
`jobctrl-demo-telemetry` D1 database. Generated Wrangler bindings are
intentionally ignored—the checked-in environment contract contains only the
four bindings used by this package.

The demo's current CI and deployment gates are defined by
`.github/workflows/demo-edge.yml` and `.github/workflows/demo-site.yml`.
Deployment and rollback require separate authorization; inspect the exact
candidate and current workflow state before reporting a result.

## Verify

Use the recurring Python application journeys and static checks described in
[Python Application Journeys](developer/qa/python-journeys.md) and
[Reliability & QA](local-reliability-qa.md):

```bash
corepack pnpm e2e
```

The journey command builds the web application once, then exercises the real
Python API, worker, Temporal, SQLite and renderer in owned synthetic workspaces.
External model and provider boundaries are controlled. A full Profile-only
transfer is a separate one-off synthetic integrity proof; never perform a live
user reset as part of development or QA. Packaging and installed-runtime
changes also require their own real-entry-point checks. A documented command or
scenario is not evidence that it passed on the candidate.

## Pull-request CI

Maintainer approval remains required for workflow runs from external forks.
The current CI configuration runs trusted privacy admission, direct static
checks, and the complete Python/Chromium journey lane defined by
`.github/workflows/ci-e2e.yml`. Admission examines the candidate before candidate
code or dependencies run. The journey lane builds once and uses the same real
application boundaries as the local command above. Inspect the actual run and
candidate identity before reporting a pass; legacy unit, component, snapshot,
Fastify and JSON-RPC test lanes do not establish target behavior.

## Test And Documentation Workspaces

The recurring journey runner creates a new owned run directory and independent
synthetic application workspaces. It does not adopt a caller-selected database,
real Profile, browser profile, credential store or personal environment. It
uses real application services and controls only external boundaries. See the
[Python journey ledger](developer/qa/python-journeys.md) for the exact harness,
evidence and installed-mode requirements.

For documentation imagery, use only synthetic content in a separately owned
workspace and review every image for private data. The current state of the
capture workflow is described below. A workspace path alone does not make
inherited credentials safe.

## Publish a release

Use [Releasing JobCtrl](developer/releasing.md) for version preparation, curated
notes, exact-candidate checks, protected signing, publication, and independent
verification of every public channel.

## Build the bundled payload

The production-payload builder targets Apple-silicon macOS and is a
release-engineering path, separate from contributor setup. It requires the
source toolchain and the locked native launcher compiler.

```bash
corepack pnpm distribution:audit
corepack pnpm distribution:build
```

The builder assembles an unsigned local payload and validates its component
inventory, locked inputs and redistribution policy. A local artifact is not a
published release. The extracted-payload verification exercises the current
Python application and its real worker and renderer; see the
[Python journey ledger](developer/qa/python-journeys.md) for the observed
candidate and limits. Signed acquisition, platform and release verification
remain separate; follow [Releasing JobCtrl](developer/releasing.md).

## First-Run TTFV Measurement

Earlier first-run timing procedures predate the current application, and their
recorder is not a current source command. Any new real-provider measurement
requires explicit owner authorization, an agreed current procedure and evidence
for its exact candidate; synthetic journey timings do not establish user
outcomes.

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
corepack pnpm web:dev
```

Check frontend boundaries, typecheck, and build:

```bash
corepack pnpm web:lint
corepack pnpm web:check
corepack pnpm web:build
```

`web:lint` checks production imports and browser-capability access. Existing
boundary debt has scoped exceptions; new imports cannot silently widen them.
See the
[frontend boundary checks](architecture/frontend/state-and-ports.md#automated-boundary-checks)
for the enforced rules, legitimate infrastructure access, and review limits.

### Frontend and coaching verification

The recurring behavior suite is the real-application journey suite:

```bash
corepack pnpm e2e
corepack pnpm e2e -- --grep 'approved baseline'
```

The second command focuses a named journey. The harness and scenarios live in
`apps/web/e2e/harness/` and `apps/web/e2e/journeys/`; see the
[coverage ledger](developer/qa/python-journeys.md) for the required behavior and
current verification status. Required-bullet coaching must be checked through
source-bound model decisions, forged and stale sources, provider failure, and
save conflicts in an owned synthetic workspace. Static frontend boundaries,
types and builds remain separate checks; no passing result is implied here.

## Browser Extension

The Manifest V3 extension under `apps/extension` is a local capture/autofill
client and an optional Discovery transport for the Python application.

```bash
corepack pnpm extension:check
corepack pnpm extension:build
```

The build writes `dist/extension/`. In Chrome, enable **Developer mode** at
`chrome://extensions` and load that directory as an unpacked extension. After a
rebuild, reload the extension and any existing application tabs. The source
launcher also builds it before starting or restarting the product web component.

Pairing, capture and Discovery behavior are exercised through the recurring
application journeys; see the [coverage ledger](developer/qa/python-journeys.md)
and use an owned synthetic workspace. A build alone does not establish that the
extension is paired or that a browser journey passed.

## Docs Site

The documentation under `docs/` (minus internal planning docs) is also a
static VitePress site, configured in `docs/.vitepress/config.ts`. The site
publishes the user guide, developer guide, architecture docs, and reference
docs behind a hero landing page (`docs/index.md`); `docs/plans/`,
`docs/incidents/`, and the repo-facing `docs/README.md`
map stay repository-only, and links that point at unpublished or repo-root
files are rewritten to GitHub URLs at build time.

```bash
corepack pnpm docs:dev
corepack pnpm docs:build
corepack pnpm docs:check:runtime
corepack pnpm docs:preview
```

`corepack pnpm docs:dev` is the foreground server and stops with Ctrl-C. For a tracked
background server that returns control to the shell, use:

```bash
corepack pnpm docs:start
corepack pnpm docs:status
corepack pnpm docs:stop
```

`corepack pnpm docs:start` prints the observed VitePress URL (requested port `4174`) and
returns. Use that URL because VitePress may select a higher port when the
requested one is occupied. Its PID and log use the shared `.dev/` launcher
state; inspect the log with `corepack pnpm dev:logs docs`.

`corepack pnpm docs:build` fails on dead internal links, then runs
`scripts/check-docs-site-links.mjs`, which fails if any href/src emitted into
the built site does not resolve to a built page or asset (this catches links
to pages relocated by `rewrites`, which VitePress's source-level dead-link
check cannot see). Together they are the docs link-integrity gate. The docs
workflow (`.github/workflows/docs-site.yml`) runs these checks and the rendered
Chromium regression gate on matching pull requests and pushes to `main`, before
uploading the site artifact. It also supports manual runs. Mermaid diagrams render client-side in
the browser, so a build that passes can still contain a diagram that fails to
parse. `corepack pnpm docs:check:runtime` starts a fresh preview and checks hydration,
images, navigation, responsive diagrams, search, the comparison screenshot-carousel
interaction, and the desktop/mobile comparison layout (including keyboard access to
its wide table) in Chromium. It also intercepts the Google tag and proves the
documentation cookie banner makes no analytics request before acceptance,
persists both choices, emits SPA page views only after acceptance, and stops
tracking plus clears site analytics cookies after withdrawal.
Choose whether this browser gate is required using
[Documentation verification](developer/documentation-standards.md#verification),
and run it after `corepack pnpm docs:build` when required. Note that
`corepack pnpm docs:preview` snapshots the built file list at startup: after any
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

Documentation imagery must use synthetic data and be inspected for private
content, clipped layout and misleading product state. The former automated
capture wrapper targets a retired browser suite and is not a valid capture path
for the Python application. Until a current capture workflow is implemented and
verified, do not claim that it regenerates the gallery or run it against a real
workspace. Images illustrate screens; they do not prove multi-step behavior.

### Launch Demo Asset Inventory

Use the [Python journey ledger](developer/qa/python-journeys.md) for observed
application behavior and verification limits. Existing demo and documentation
images are illustrative and must never be regenerated from personal data.

## Screening CLI

The installed CLI supports `jobctrl screening read JOB_ID` and
`jobctrl screening write JOB_ID command.json`. From source, use
`uv --project workers/automation run --no-sync python -m jobctrl screening read JOB_ID`.
The [user reference](user/screening-answers.md#cli-and-local-api) describes the
command fields and privacy boundaries.
