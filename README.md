# JobHunter

JobHunter is a local-first job search automation system. It keeps your profile,
job database, generated materials, browser state, and logs on your machine while
helping you move jobs through a focused pipeline:

```text
discover -> apply
```

Discovery finds and enriches jobs, scores them against your candidate profile,
and prepares tailored materials when the job is eligible. Apply is separate
because it can drive browser automation and submit applications.

## What It Does

- Discover jobs from configured searches and supported source registries.
- Optionally reconcile a local Temporal Schedule for discovery; it is disabled
  by default and uses the configured cron only after you enable it.
- Enrich postings with full descriptions, canonical posting URLs, and apply URLs.
- Capture a current browser job page through the optional local browser
  extension, which feeds the existing manual-capture import path.
- Score jobs as an applicant-side triage aid with auditable evidence.
- Generate tailored resumes, cover letters, PDFs, and review artifacts.
- Review and edit generated resumes in Apply Review before approval.
- Inspect the evidence map to see which profile achievements and skills are
  reused in generated materials, requirement-fit decisions, and recorded gaps.
- Generate stored interview prep for a selected job from grounded JobHunter
  data, with evidence links and gap drills kept inspectable before the interview.
- Edit resume PDF style templates in Preferences, choose a default template, and
  override the template per job without modifying candidate profile data.
- Track pipeline state, failures, retries, workflow runs, artifacts, and apply
  history in a local web UI.
- Optionally run browser-based apply automation, starting with dry runs.

Auto-apply is powerful and must be treated as an explicit submission tool. Use
dry-run paths and narrow targets before allowing it to submit anything.
Live browser submission requires an Apply Review approval by default
(`applyApprovalRequired: true`). If you turn that gate off in Preferences, the
settings form shows a persistent warning because the agent may submit
applications immediately after claiming a job. Dry-run still keeps the prompt
instruction, and it also installs a browser-layer CDP guard that blocks
non-loopback POST/PUT/PATCH requests and form submits (only localhost
targets are allowed).

## Responsible Use

JobHunter is an applicant-side automation tool. Treat the paths that touch
employers, accounts, provider APIs, and third-party sites as live operations:

- Live apply automation can submit real applications to real employers. Keep
  `applyApprovalRequired` on, rehearse with dry runs, and target one job or site
  at a time until you trust the behavior.
- Email-based application sending, if you enable or build it, is also a live
  employer submission. The current Gmail connector is read-only; do not grant or
  wire Gmail `gmail.send` unless you intend JobHunter to send application email
  from your account.
- Browser automation can type credentials you provide. Use a unique, dedicated
  job-site password, not an email, banking, work, or reused personal password.
- CAPTCHA solving is off unless `CAPSOLVER_API_KEY` is configured. Setting that
  key sends CAPTCHA site keys and page URLs to a paid third-party solver, and
  you are responsible for each site's terms and legal constraints.
- Scraping and source access can violate site terms. Default discovery options
  include LinkedIn and Indeed; disable any source you are not allowed to query
  automatically.
- The local API is intended for loopback use. Ordinary web and CLI callers use
  the loopback boundary; browser-extension API routes additionally require a
  local capability token shown in Settings and stored under `~/.jobhunter/`. Do
  not bind the API to a network interface or tunnel it unless you accept
  exposing private profile, job, and artifact data.
- LLM work can spend money and send job, profile, and generated-material text to
  configured providers. `dailyBudgetUsd` caps new spendful workflows locally,
  but it is an estimate rather than the provider bill.
- Interview prep is stored pre-interview material only. You can record
  post-interview reflection notes against an accepted prep generation, but do
  not use JobHunter as a live interview assistant; it has no transcript,
  microphone, streaming, websocket, or real-time answer surface.
- Profiles, generated materials, browser state, logs, SQLite databases, and
  local worker state are sensitive local artifacts. Public bug reports,
  screenshots, and reproduction cases should use synthetic data only; `pnpm
  qa:seed` creates a disposable synthetic workspace for that purpose.

## Current System

JobHunter has three local runtime components:

- `apps/api`: local TypeScript/Fastify API for read models, profile/settings,
  structured actions, artifacts, and worker dispatch.
- `apps/web`: React/Vite app using TanStack Router, Query, and Form, a shared
  filterable data grid, and SSE-backed cache invalidation.
- `workers/automation`: Python automation engine, CLI, Temporal worker,
  discovery, scoring, materials, PDF rendering, and apply automation.

SQLite and local files are the source of truth. Hosted accounts, billing,
managed browsers, object storage, and SaaS deployment stay out of local mode; see
[ROADMAP.md](ROADMAP.md).

## Quick Start

Requirements:

- Python 3.11+
- Node.js 20.19+
- pnpm through Corepack
- uv
- Temporal CLI with `temporal server start-dev`
- Playwright Chromium for HTML/CSS PDF rendering
- Chrome or Chromium for browser automation
- Poppler (`pdftoppm` on `PATH`) for PDF page previews
- an LLM provider key or local LLM endpoint for scoring and materials

Install and run:

```bash
git clone https://github.com/ebarti/JobHunter.git
cd JobHunter
pnpm install:interactive
uv --project workers/automation run jobhunter init
uv --project workers/automation run jobhunter doctor
pnpm dev
```

`pnpm install:interactive` checks local system tools, offers guided installs
when Homebrew is available, installs the Node and Python dependencies, and
installs the Playwright Chromium browsers used by web tests and PDF rendering.
For an already provisioned machine or CI-style setup, `pnpm dev:setup` remains
the non-interactive Node + Python dependency sync.

Playwright Chromium is installed per Python virtualenv, and both discovery
scraping and HTML/CSS PDF rendering need it. `pnpm install:interactive` installs
it for you, but `pnpm dev:setup`, a bare `uv sync`, or a fresh git worktree does
not — run `uv --project workers/automation run playwright install chromium` in
that checkout before starting the worker. Multiple git worktrees share the
`~/Library/Caches/ms-playwright` cache, so running `playwright install` from a
checkout on a newer Playwright version can garbage-collect the browser revision
an older worktree still needs; set `PLAYWRIGHT_SKIP_BROWSER_GC=1` when
installing from another checkout to keep both. `jobhunter doctor` validates the
browser, and the worker refuses to start without it (set
`JOBHUNTER_SKIP_BROWSER_PREFLIGHT=1` to override, e.g. for a worker that runs
only non-browser activities).

`pnpm dev` starts the full local stack in the foreground: Temporal dev server,
TypeScript API, Vite web app, and Python worker. Keep the terminal open while
using the app and stop it with Ctrl-C.

### Browser Extension Capture And Autofill

The optional Manifest V3 browser extension is a local capture and assist
surface. Build it with:

```bash
pnpm extension:build
```

Load `dist/extension/` as an unpacked extension in Chrome/Chromium developer
mode, then open JobHunter Settings and copy the browser-extension pairing token
into the extension popup.

Clicking **Save job** captures the active http(s) page URL and visible text,
posts it over loopback to `/v1/extension/captures`, and reuses the existing
manual-capture importer so dedupe, snapshots, quarantine, and source provenance
remain identical to other user-mediated captures. If the local stack is down,
the extension stores a bounded local queue in extension storage and retries
after the next successful save.

On supported ATS application pages, **Review autofill** fetches a whitelisted
profile snapshot over loopback and shows deterministic field suggestions with
their profile source. You choose which values to fill. The extension does not
generate free-text answers and has no submission path.

Commands that start work (`jobhunter run`, per-stage commands, `jobhunter
apply`, `jobhunter action profile_import`, and `jobhunter
compensation-refresh`) start Temporal workflows and wait on their handles. They require a reachable Temporal server plus a running JobHunter
worker: use `pnpm dev`, or start `temporal server start-dev` and
`uv --project workers/automation run jobhunter worker` yourself. They do not
fall back to the old in-process pipeline path.

For the full first-run guide, see
[docs/user/getting-started.md](docs/user/getting-started.md).

## Local Data And Safety

By default, JobHunter writes local data under:

```text
~/.jobhunter/
```

Important local files include:

- `jobhunter.db`: local SQLite database with profile, jobs, events,
  projections, settings, and artifact metadata.
- `.env`: provider keys and local runtime settings.
- `tailored_resumes/`, `cover_letters/`, `logs/`: generated artifacts and logs.
- `chrome-workers/`, `apply-workers/`: local browser/apply worker state.
- `codex_home/`: isolated Codex SDK home when apply/review agents need it.
- `backups/`: timestamped database snapshots written by `jobhunter backup`.

The daily digest is local-only. `jobhunter digest` and the Dashboard digest read
from `jobhunter.db` without sending notifications or advancing review state;
only the explicit Dashboard acknowledge action or `jobhunter digest
--acknowledge` updates the `digest_state` watermark.

Never commit profiles, API keys, generated resumes, cover letters, PDFs, browser
profiles, logs, SQLite databases, screenshots containing real data, or local
worker state. See [docs/user/data-and-safety.md](docs/user/data-and-safety.md)
and [SECURITY.md](SECURITY.md).

### Back Up And Restore

All product state lives in `jobhunter.db`. Take a consistent snapshot at any
time — even while the app is running — with:

```bash
uv --project workers/automation run jobhunter backup
```

This writes `~/.jobhunter/backups/jobhunter-<timestamp>.db` using SQLite
`VACUUM INTO`, prints the path, and never deletes anything. Pass `--output
<path>` to choose a specific file or target directory.

To restore, stop the app (Ctrl-C on `pnpm dev`), clear any stale WAL sidecars,
then copy a backup over the live database:

```bash
rm -f ~/.jobhunter/jobhunter.db-wal ~/.jobhunter/jobhunter.db-shm
cp ~/.jobhunter/backups/jobhunter-<timestamp>.db ~/.jobhunter/jobhunter.db
```

Always restore the whole file — never hand-import individual tables from a
backup. The read-model's projection watermark only ever moves forward, so a
partial reconstruction can leave it ahead of the restored `job_events` and stall
projection refresh; if you ever rebuild the database piecemeal, delete the
`operations_projections` watermark row afterwards so the projections rebuild from
scratch:

```bash
sqlite3 ~/.jobhunter/jobhunter.db \
  "DELETE FROM event_watermarks WHERE projection_name = 'operations_projections';"
```

## Normal Flow

1. Create or import a candidate profile.
2. Configure target roles, locations, work models, and application preferences.
3. Run Discover from the UI or CLI, optionally targeting a single source from
   the Pipelines tab when you want a lighter retry.
4. Review jobs, scores, blockers, compensation evidence, and audit history.
5. Open Evidence from the main nav, Profile, or a job detail drawer to inspect
   which profile evidence backs generated materials and requirement-fit gaps.
6. Generate or inspect materials and stored interview prep for promising jobs.
7. Use Apply Review to edit/approve the resume, review comments, and compare a
   rendered draft against the accepted artifact before approval.
8. Run apply dry-runs before approving any real browser submission; the default
   live path requires an `approve_submit` decision in Apply Review before the
   backend claim can proceed.
9. Track progress in Dashboard, Analytics, Jobs, Runs, Artifacts, Evidence, Apply Review,
   and Debug.

See [docs/user/normal-flows.md](docs/user/normal-flows.md) for commands and
expected state transitions.

## CLI Reference

All commands run as `uv --project workers/automation run jobhunter <command>`.
Work-starting commands need the Temporal dev server plus a running worker
(`pnpm dev` provides both).

| Command | What it does |
| --- | --- |
| `init` | Create local configuration under `~/.jobhunter/`. |
| `doctor` | Report feature tiers: database, LLM, Temporal, browser, Gmail, telemetry. |
| `run [stages]` | Start pipeline workflows (default `all`, which maps to `discover`). |
| `discover` / `enrich` / `score` / `tailor` / `cover` | Start one stage; `score --rescore` re-scores reset stale scores. |
| `job <url>` | Tailor and/or apply one job (`--tailor`, `--apply`, `--dry-run`). |
| `apply` | Start apply automation; utility modes: `--mark-applied`, `--mark-failed`, `--reset-failed`, `--gen`, `--continuous`. |
| `retry <stage> <url>` | Reset one failed stage for one job (`--reset-attempts`, `--run`). |
| `action <stage>` | Low-level single-action dispatch with JSON output (used by scripts). |
| `compensation-refresh` | Re-parse posted salaries and refresh market estimates (`--url`, `--observations-json`). |
| `status` / `runs` | Inspect database stats and run telemetry (`runs --failed-only`). |
| `digest` | Print the local daily digest (`--json`, `--acknowledge`, `--min-fit-score`). |
| `worker` | Run the long-lived Temporal worker. |
| `rpc` | JSON-RPC server spawned by the TypeScript API (internal). |
| `backup` | Snapshot the SQLite database via `VACUUM INTO` (`--output`). |
| `migrate-resume-html` | Convert/refresh approved resume PDFs onto the HTML/CSS renderer. |
| `gmail-auth` | Authenticate the read-only Gmail connector. |

## Configuration

Configuration comes from three places:

- the local SQLite profile/settings database;
- environment variables in `~/.jobhunter/.env`, repo `.env`, or an explicit
  shell environment;
- package-shipped source registries under `workers/automation/src/jobhunter/config/`.

Start with [.env.example](.env.example), then read the full reference in
[docs/user/configuration.md](docs/user/configuration.md).

Common variables:

- `JOBHUNTER_DIR`: override the local app directory.
- `GEMINI_API_KEY`, `OPENAI_API_KEY`, or `LLM_URL`: configure LLM access.
- `LLM_MODEL`: choose the default model for the configured provider.
- `VITE_GOOGLE_MAPS_API_KEY`: optional address search in the Profile form.
- `CHROME_PATH`: override Chrome/Chromium detection.
- `JOBHUNTER_RESUME_RENDERER=latex_pdf`: opt into the LaTeX resume compatibility
  renderer. The default is HTML/CSS printed by Playwright.
- `PLAYWRIGHT_SKIP_BROWSER_GC=1`: keep other worktrees' Playwright browsers when
  running `playwright install` from this checkout (they share the
  `~/Library/Caches/ms-playwright` cache).
- `JOBHUNTER_SKIP_BROWSER_PREFLIGHT=1`: skip the worker's startup Playwright
  Chromium check (for a worker that runs only non-browser activities).
- `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`: optional
  OpenTelemetry/Langfuse export. Set `LANGFUSE_DISABLE=1` to opt out.

Discovery scheduling is controlled by the discovery runtime settings stored in
SQLite. `scheduling_enabled` defaults to `false`; `schedule_cron` defaults to
`0 7 * * *` and is interpreted by the local Temporal dev server. When disabled,
worker startup deletes any existing local discovery schedule instead of running
background discovery.

LLM spend is tracked locally in SQLite from the existing LLM usage capture
points. `dailyBudgetUsd` defaults to `25`; set it to `0` in Preferences to make
the local budget unlimited. Workflows that spend LLM tokens run a budget
preflight before starting their heavy activity, and the health surface shows
today's estimated spend against the configured budget.

## Development

```bash
pnpm install:interactive
pnpm check
pnpm test
uv --project workers/automation run --extra dev python -m build workers/automation
git diff --check
```

Useful focused commands:

```bash
pnpm api:check
pnpm api:test
pnpm web:check
pnpm web:build
pnpm web:test
pnpm web:e2e
pnpm extension:check
pnpm extension:test
pnpm extension:e2e
uv --project workers/automation run --extra dev pytest -q
```

For contributor workflow, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Screenshots

Documentation screenshots must be generated from synthetic data. Use:

```bash
pnpm docs:screenshots
```

![Dashboard with synthetic data](docs/assets/screenshots/dashboard.png)

![Apply Review with synthetic data](docs/assets/screenshots/apply-review.png)

The Documentation Screenshots section of
[docs/local-development.md](docs/local-development.md)
explains the disposable database, routes, and refresh process.

## Documentation

- [docs/user/](docs/user/): end-user setup, configuration, normal flows, safety,
  and screenshot references.
- [docs/developer/](docs/developer/): contributor onboarding and architecture
  reading path.
- [docs/architecture/](docs/architecture/index.md): system architecture — runtime
  boundaries, observability, storage, scoring, materials audit, and read model.
- [docs/architecture/pipeline/](docs/architecture/pipeline/index.md):
  stage-by-stage pipeline sequence and class diagrams.
- [docs/local-reliability-qa.md](docs/local-reliability-qa.md): regression
  matrix and QA gates.
- [docs/decisions.md](docs/decisions.md): accepted architecture decisions.
- [docs/backlog.md](docs/backlog.md): detailed engineering backlog.
- [docs/plans/](docs/plans/): proposal and implementation records.

## License

JobHunter is licensed under AGPL-3.0-only. See [LICENSE](LICENSE).
