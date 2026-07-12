# Local Development

JobCtrl is a pnpm TypeScript workspace plus a uv-managed Python worker (a
Temporal worker process that executes workflows). This page is the local loop
end to end: install dependencies, run the full stack, verify a change, and the
frontend, docs-site, and documentation-screenshot workflows.

**Read this if** you are running or changing a source checkout. These commands
install contributor dependencies and are deliberately different from the
installed product contract. After the first signed bundled release is
published, installed users will run `jobctrl start` and plain
`jobctrl <command>` from any directory; they will not use this page's Git,
pnpm, Corepack, uv, or checkout-relative commands.

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

`scripts/get` is now the transport-only bootstrap boundary for the planned
bundled distribution; it neither clones a checkout nor provisions contributor
tools. The P0–P6 implementation exists, but no signed and notarized public
artifact, authenticated release pointer, or stable Homebrew formula has been
published. Its normal network path therefore still fails closed. Use
`scripts/install` and the source commands on this page for contributor work.
`docs/public/install.sh` must stay byte-for-byte identical to `scripts/get`;
`pnpm docs:build` checks that before building the site.

For machines that already have the system tools and browsers installed, use the
non-interactive dependency sync:

```bash
corepack pnpm dev:setup
```

`corepack pnpm dev:setup` installs the Node workspace dependencies and runs
`uv --project workers/automation sync --extra dev`, which installs the Python
worker, `python-jobspy`, JobSpy's locked transitive dependencies, and
the Python dev tools used by local checks. It does not install Temporal or
Playwright browser binaries. System Chrome/Chromium is optional; contributor
testing of apply behavior must explicitly enable a browser capability first.

The source installer downloads separate web/E2E and Python-worker Playwright
Chromium revisions. The bundled release candidate instead contains exactly one
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
- Temporal persistence: `.dev/temporal/temporal.db`
  (`JOBCTRL_TEMPORAL_DB` can override it)

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
temporal server start-dev --db-filename .dev/temporal/temporal.db
pnpm api:dev
pnpm web:dev
uv --project workers/automation run jobctrl worker
uv --project workers/automation run jobctrl doctor
```

The Temporal dev server binds the frontend gRPC service on `127.0.0.1:7233` and
the Web UI on `http://127.0.0.1:8233`. The launcher passes
`--db-filename "$JOBCTRL_TEMPORAL_DB"` so workflow history persists across
launcher restarts instead of disappearing when the process exits. With Temporal
running, `jobctrl doctor` reports `Temporal: reachable`. The Vite web dev
server proxies `/v1/*` to the TypeScript API by default.

### Public demo browser workspace

Run the frontend-only public demo with synthetic data and no JobCtrl API,
Temporal, worker, SSE, or host-OS integration:

```bash
VITE_JOBCTRL_APP_MODE=demo corepack pnpm web:dev
```

Only the exact value `demo` selects this composition. A missing or invalid
`VITE_JOBCTRL_APP_MODE` keeps the normal local composition, so a mistyped value
cannot produce a partially mounted app.

The demo workspace persists in IndexedDB and is shared by tabs and people using
the same browser profile. Separate browser profiles and private/incognito
contexts are isolated. Reset rotates the workspace identity, clears pending
demo actions, and deletes generated demo blobs in the same transaction. If
IndexedDB is unavailable or full, the page warns that it has switched to
tab-local memory; those fallback changes are neither shared nor retained after
the tab closes. The demo contains synthetic data, but visitors should still not
enter personal data or secrets. Product reads, filtering, sorting, pagination,
details, bundled previews, and safe synchronous write actions are served from
that browser-local workspace. Those writes are atomic, survive reload, and
remain visible across same-profile tabs. Provider-backed, external, and
long-running actions stay unavailable until their explicit no-effect receipt
or deterministic scenario implementation lands; the demo never falls back to
the product API.

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
corepack pnpm --filter @jobctrl/web e2e:demo-workspace
pnpm scripts:test
pnpm qa:test
pnpm extension:check
pnpm extension:test
pnpm extension:build
pnpm extension:e2e
```

Regenerate public documentation screenshots with `pnpm docs:screenshots` — see
[Documentation Screenshots](#documentation-screenshots).

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

The Manifest V3 browser extension lives under `apps/extension`. It is a local
capture client for the TypeScript API, not a hosted/browser-store package.

```bash
pnpm extension:check
pnpm extension:test
pnpm extension:build
pnpm extension:e2e
```

`pnpm extension:build` writes the unpacked extension bundle to
`dist/extension/`; load that directory in Chrome/Chromium developer mode for
manual QA. The extension uses `activeTab`, `scripting`, and `storage`, and its
manifest network permissions are limited to `http://127.0.0.1:8766/*` and
`http://localhost:8766/*`. `pnpm extension:e2e` builds the bundle and scans the
built manifest/assets for the localhost-only invariant.

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
images, navigation, responsive diagrams, search, and the desktop/mobile
comparison layout (including keyboard access to its wide table) in Chromium;
run it after `pnpm docs:build` for public-doc changes. Note that
`pnpm docs:preview` snapshots the built file list at startup: after any
rebuild, restart the preview server or hashed assets will 404. Deploys to
Cloudflare Pages run from `main` once the `DOCS_DEPLOY_ENABLED` repository
variable and the Cloudflare credentials are configured.

## Documentation Screenshots

Public screenshots are generated from synthetic data only — never from a real
`~/.jobctrl` workspace.

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

The spec is opt-in: it only writes when `JOBCTRL_DOCS_SCREENSHOTS=1` is set,
which `pnpm docs:screenshots` does for you. A bare full e2e run
(`pnpm --filter @jobctrl/web e2e`) skips it, so QA runs never rewrite the
committed screenshots.

When running multiple worktrees, override the disposable paths and ports:

```bash
JOBCTRL_E2E_APP_DIR=/tmp/jobctrl-docs-shots \
JOBCTRL_E2E_API_PORT=8890 \
JOBCTRL_E2E_WEB_PORT=5290 \
pnpm docs:screenshots
```

Refresh checklist: run the command on a clean checkout, review every PNG for
private data / broken layout / local-path leaks, confirm the homepage hero copy
at `docs/public/assets/screenshots/dashboard.png` was refreshed from the
gallery dashboard screenshot, update docs if screenshot names changed, and
finish with `git diff --check`.

Safety rules: never point generation at `~/.jobctrl`; never use real
resumes, databases, logs, Gmail tokens, or browser profiles; do not run apply
automation, mailbox scans, real crawling, or real LLM calls for screenshots;
keep output deterministic (fixed viewport, synthetic database, seeded
heartbeat, no external providers).

### Launch Demo Asset Inventory

The launch demo assets each prove one product invariant from synthetic data.
Each asset is classified **A** (static, already covered), **B** (static, new seed
state), or **C** (dynamic/lifecycle — a driven flow that is *defined* here, not
executed by CI), and maps to a `Current` row in the repository-only claims ledger
(`docs/claims-ledger.md`), which is the committed source of truth for every claim
below.

| # | Asset | Class | Claim(s) | Regeneration / proof | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | First run → empty dashboard | B | `CL-060`, `CL-072` | Empty-workspace seed variant + a `docs-screenshots.spec.ts` onboarding surface | Deferred — needs an empty-workspace seed variant + capture surface |
| 2 | Resume / profile import | B/C | `CL-080` | Profile-import wizard capture from a synthetic resume | Deferred — needs an import-flow capture surface |
| 3 | Discovery → scored jobs + requirement fit + provenance | A | `CL-001`, `CL-010`, `CL-011`, `CL-020` | `pnpm docs:screenshots` → `jobs.png`, `job-detail.png` (seed: scored job, `job_requirement_fit_items`, `job_bullet_provenance`) | Covered |
| 4 | Apply-review audit surfaces | A | `CL-023`, `CL-024`, `CL-030` | `pnpm docs:screenshots` → `apply-review.png` (seed: approved generation, evidence, `change_annotations`) | Covered |
| 5 | Failed refresh preserves last accepted artifact | B | `CL-025` | Regression tests `apps/api/test/resume-templates.test.ts` ("keeps the last accepted resume artifact when the PDF render fails"; "reports refresh unavailable without hiding the last accepted artifact") and `apps/api/test/resume-review-drafts.test.ts` ("fails the render and preserves prior approved artifacts …"); run `pnpm api:test` | Covered — invariant proven from fixture |
| 6 | Tailoring gate rejects an unsupported claim | B | `CL-021` | Grounding-gate regression `workers/automation/tests/test_claim_grounding.py` (a claim whose text is absent from the shipped resume is flagged `ungrounded` with an inspectable reason — the CL-021 fail-closed behaviour) and `workers/automation/tests/test_coverage_audit.py` (fabricated/stuffed keywords fall into `missing`); the apply-review rendering of the resulting blocker is seeded in `apps/api/test/qa-seed.ts` and asserted by `apps/api/test/application-feedback.test.ts` | Covered — gate + surface proven from fixtures |
| 7 | Dry-run apply completes + live-approval gate + blocked-channel evidence | B / C | `CL-030`–`CL-034` | Approval card + dry-run run (`qa-run-1`) via `pnpm docs:screenshots`; live blocked-channel evidence via a driven dry-run (capability shipped: approval binding + dry-run evidence) | Approval card + dry-run run Covered; live blocked-channel evidence Defined (class C) |
| 8 | Spend-ceiling stop + health surface | B / C | `CL-040`, `CL-041` | Health surface with an `llm_spend`-at/over-budget seed fixture + capture; stop lifecycle via a driven run (spend ceiling shipped) | Deferred — needs an `llm_spend` seed fixture + health capture; stop lifecycle Defined (class C) |
| 9 | Reliability demo — kill worker, restart, resume | C | `CL-050` (`TR-008`) | `scripts/reliability-demo.sh` drives `DurabilityProbeWorkflow` (a hermetic durable-timer probe — no crawl/LLM) on an isolated stack; kills the worker by captured PID tree and asserts the same run ids resume in Temporal + the read-model projection. Probe covered by `workers/automation/tests/test_workflow_durability_probe.py`; see [Reliability & QA → Durable-Execution Recovery Demo](local-reliability-qa.md#durable-execution-recovery-demo) | Defined — self-asserting, re-runnable script (verified locally) |

Deferred assets (1, 2, 8 health capture) are launch-set follow-ups: they need a
new synthetic seed variant or capture surface, not a missing product capability.
Class-C assets (7 live evidence, 8 stop lifecycle, 9) are defined driven flows,
never faked with a staged static image. No asset regenerates from a real
workspace.
