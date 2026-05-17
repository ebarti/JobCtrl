# JobHunter

JobHunter is a local-first job search automation system. It keeps your profile,
job database, generated materials, browser state, and logs on your machine while
helping you move jobs through a staged pipeline:

```text
discover -> enrich -> score -> tailor -> cover -> pdf -> apply
```

The automation engine is Python. The newer product surface is a local
TypeScript API plus a React/Vite web shell. The intended frontend direction is
TanStack Router for client-side routing plus TanStack Query for API/cache state
management. SQLite and local files remain the source of truth while the project
validates reliability before any hosted/SaaS hardening.

## What It Does

JobHunter can:

- find jobs from configured searches and supported source registries;
- enrich job rows with full descriptions and application URLs;
- score jobs against your candidate profile with an LLM;
- tailor resumes from your structured resume baseline;
- generate cover letters;
- convert generated text artifacts to PDFs;
- show stage state, failures, retries, artifacts, and apply runs in a local UI;
- optionally drive local browser-based application submission.

Auto-apply is powerful and should be treated as an explicit submission tool. Use
dry-run paths and targeted commands before allowing it to submit anything.

## Current System Shape

JobHunter is split by responsibility:

- `apps/api`: local TypeScript/Fastify API for typed read models, local
  product actions, profile/settings, artifacts, and worker invocation.
- `apps/web`: current React/Vite local web shell; planned direction is
  TanStack Router plus TanStack Query as the UI grows beyond the shell.
- `workers/automation/src/jobhunter`: Python automation engine, CLI, workers,
  profile import, PDF creation, and apply automation.

## Safety And Data

By default, JobHunter writes user data under:

```text
~/.jobhunter/
```

Important local files include:

- `jobhunter.db`: local SQLite database, including normalized candidate profile,
  jobs, events, projections, and artifact metadata.
- `searches.yaml`: search targets and discovery configuration.
- `.env`: API keys and local runtime settings.
- `profile.json`, `resume_template.tex`, and `resume_style.json`: legacy
  profile/rendering seed files imported into SQLite when no profile row exists.
- `tailored_resumes/`, `cover_letters/`, `logs/`: generated artifacts.
- `chrome-workers/`, `apply-workers/`: local browser/apply worker state.

Do not commit profile data, keys, generated resumes, cover letters, PDFs,
browser profiles, logs, or SQLite databases.

Job scoring is an applicant-side triage aid. Scores, criteria snapshots,
eligibility blockers, confidence, trace metadata, and user corrections are
stored locally so you can inspect why a job was ranked or gated. Do not use
JobHunter as an employer-side candidate screening or selection tool without a
separate legal, bias-audit, validation, and notice process.

The local TypeScript API binds to `127.0.0.1` by default. Binding it to a
non-loopback interface requires an explicit opt-in because it exposes local job,
profile, and artifact metadata.

## Requirements

Core pipeline:

- Python 3.11 or newer.
- A local LLM provider configuration for scoring, tailoring, and cover letters.
  Gemini, OpenAI, and local HTTP-backed providers are supported through
  environment variables.
- A TeX distribution with `pdflatex` for PDF output.
- Temporal dev server (`temporal server start-dev`) for the workflow engine
  the Python worker runs against. See `docs/local-development.md`.

Local API and web UI:

- Node.js 20.19 or newer.
- pnpm through Corepack.

Auto-apply:

- Chrome or Chromium.
- Node.js and `npx` for the Playwright MCP runtime.
- Claude Code CLI for browser-driven form completion.
- Optional `CAPSOLVER_API_KEY` for CAPTCHA solving.

Run the doctor command after setup. It is the fastest way to see which tier of
functionality is available on your machine.

## Install From Source

```bash
git clone https://github.com/ebarti/JobHunter.git
cd JobHunter
corepack pnpm install
uv --project workers/automation sync
uv --project workers/automation run jobhunter doctor
```

For development of the local TypeScript API and current React/Vite shell:

```bash
pnpm test
```

Discovery can use `python-jobspy` when installed. If `jobhunter doctor` reports
that JobSpy is missing, install it with the command shown by the doctor output.

## First-Time Setup

Create your local profile and configuration:

```bash
uv --project workers/automation run jobhunter init
uv --project workers/automation run jobhunter doctor
```

The setup writes local files into `~/.jobhunter`. Review them before running a
large pipeline:

```bash
ls ~/.jobhunter
```

At minimum, confirm:

- your profile and resume facts are accurate;
- your search configuration is narrow enough for a first run;
- your LLM key or local model endpoint is configured;
- `pdflatex` is available if you need PDFs;
- Chrome and Claude Code are available only if you intend to use auto-apply.

## Running The Pipeline

Run all material-generation stages:

```bash
uv --project workers/automation run jobhunter run
```

Run specific stages:

```bash
uv --project workers/automation run jobhunter discover
uv --project workers/automation run jobhunter enrich
uv --project workers/automation run jobhunter score --workers 4
uv --project workers/automation run jobhunter tailor --workers 4 --min-score 7
uv --project workers/automation run jobhunter cover --min-score 7
uv --project workers/automation run jobhunter pdf
```

Run stages by name through the orchestrator:

```bash
uv --project workers/automation run jobhunter run discover enrich score
uv --project workers/automation run jobhunter run tailor cover pdf --validation normal
uv --project workers/automation run jobhunter run --stream
```

Useful options:

- `--dry-run`: preview a stage without executing it.
- `--workers` / `-w`: parallelize supported stages.
- `--limit`: cap eligible records for supported single-stage commands.
- `--min-score`: control which scored jobs proceed to materials or apply.
- `--validation strict|normal|lenient`: tune tailoring and cover-letter checks.
- `--retailor`: regenerate tailored resumes for jobs that already have one.

## Single-Job And Retry Commands

Process one URL:

```bash
uv --project workers/automation run jobhunter job https://example.com/job/123 --tailor --dry-run
uv --project workers/automation run jobhunter job https://example.com/job/123 --tailor
uv --project workers/automation run jobhunter job https://example.com/job/123 --apply --dry-run
```

Reset one stage for one job:

```bash
uv --project workers/automation run jobhunter retry score https://example.com/job/123
uv --project workers/automation run jobhunter retry tailor https://example.com/job/123 --reset-attempts
```

`retry --run` can process other eligible pending work for some stages. Use it
deliberately.

## Auto-Apply

Auto-apply launches local browser workers and can submit applications. Start
with dry runs and narrow targets:

```bash
uv --project workers/automation run jobhunter apply --dry-run --limit 1
uv --project workers/automation run jobhunter apply --url https://example.com/job/123 --dry-run
```

Run apply for prepared jobs:

```bash
uv --project workers/automation run jobhunter apply --limit 5
uv --project workers/automation run jobhunter apply --workers 3 --min-score 8
```

Utility modes:

```bash
uv --project workers/automation run jobhunter apply --gen --url https://example.com/job/123
uv --project workers/automation run jobhunter apply --mark-applied https://example.com/job/123
uv --project workers/automation run jobhunter apply --mark-failed https://example.com/job/123 --fail-reason "manual review"
uv --project workers/automation run jobhunter apply --reset-failed
```

Auto-apply requires a prepared profile, generated materials, Chrome/Chromium,
Node.js, and Claude Code CLI.

## Structured Local Actions

The CLI also exposes a JSON-returning action surface used by local UI paths:

```bash
uv --project workers/automation run jobhunter action score --limit 5 --dry-run
uv --project workers/automation run jobhunter action apply --url https://example.com/job/123 --dry-run
uv --project workers/automation run jobhunter action profile_import --pdf ~/resume.pdf --dry-run
```

These actions record start and finish events where possible and return
structured success or failure data.

## Local UI

Run the local TypeScript API:

```bash
pnpm api:dev
```

Run the current React/Vite web shell:

```bash
pnpm web:dev
```

The Vite dev server proxies `/v1/*` to the local API by default. Set
`VITE_JOBHUNTER_API_BASE_URL` when the API runs on a different local origin.

The Pipelines tab includes global stage starts. Each stage (`discover`,
`enrich`, `score`, `tailor`, `cover`, `pdf`, `apply`) has its own tab with
persisted local config, and the tab only shows controls that the selected stage
actually consumes. Running a tab submits that stage through the local API. The
panel reports when the request is waiting on the local worker, whether the start
was queued, completed, dry-run, or failed, and the returned run/action id when
one is available. Longer-running progress appears in the dashboard pipeline,
apply runs, and recent activity cards after the API invalidates those read
models. Non-apply stages emit pipeline lifecycle events; Discover also emits
source-step events and scheduled discovery-run events for JobSpy, Workday, and
Smart Extract so a stuck or low-quality source is visible before the request
finishes. The dashboard source-health card summarizes the local source-quality
projection used to budget and demote future crawls. The Discover stage in the
Pipelines tab also exposes Discovery controls for the local source registry,
source locator candidates, observed-source preview, quarantined leads, and
manual-capture queue. Located parseable sources are automatically approved into
the active source registry; manual review is reserved for blocked, ambiguous,
or unparseable sources. These controls can add an experimental source, preview
recently observed leads for a source, enable or quarantine a source, approve or
reject quarantined leads, record source feedback, open a blocked lead in the
local browser, and import a user-provided URL, current-page URL, pasted text,
saved HTML, or email content as manual-capture provenance. Manual capture
stores local provenance metadata and content hashes, not raw captured posting
text in domain events. The `limit`
control is honored by every stage tab, including `discover` and `enrich`, so
local debug runs can be bounded to one job. A bounded Discover run stops
remaining sources once the cap is reached. Tabs default to dry-run mode so apply
automation does not submit applications unless you explicitly clear dry run.

## Inspecting Progress

Show pipeline counts:

```bash
uv --project workers/automation run jobhunter status
```

Inspect recent apply runs:

```bash
uv --project workers/automation run jobhunter runs
uv --project workers/automation run jobhunter runs --failed-only
uv --project workers/automation run jobhunter runs --run-id <prefix>
```

The normalized stage states are stored in `job_stage_states`, and events are
stored in `job_events`. Prefer the local UI/API and CLI over direct SQLite
edits.

## Configuration

JobHunter uses local user configuration plus package-shipped registries:

- `~/.jobhunter/jobhunter.db`: candidate profile source of truth, application
  defaults, resume baseline, tailoring controls, rendering settings, jobs,
  events, and projections.
- `~/.jobhunter/profile.json`: legacy seed path for first-time import when the
  profile tables are empty.
- `~/.jobhunter/searches.yaml`: searches and source settings.
- `~/.jobhunter/.env`: provider keys and runtime environment.
- `workers/automation/src/jobhunter/config/employers.yaml`: packaged employer registry.
- `workers/automation/src/jobhunter/config/sites.yaml`: packaged site and ATS behavior settings.
- `workers/automation/src/jobhunter/config/searches.example.yaml`: example search file.

JobSpy board selection uses `boards` in `searches.yaml`:

```yaml
boards:
  - indeed
  - linkedin
  - zip_recruiter
```

The legacy `sites` key is still accepted for the compatibility window and logs
a warning instead of failing. When both keys are present, `boards` wins. The
worker also builds a local source registry contract from packaged
`sites.yaml`, `employers.yaml`, and the selected JobSpy boards; migrated
Smart Extract entries start as `experimental` with the
`smart_extract_experimental` policy so existing arbitrary-site discovery keeps
working while sources are promoted or rejected.

The Preferences tab's Target search fields are discovery inputs. Target roles
replace the active discovery query list, target locations replace the active
location list, and if target locations are blank the worker falls back to the
profile city/country. A Spain or Europe target sets JobSpy's Indeed country to
Spain, broadens Europe/remote location accepts, rejects America-only non-remote
locations, and hides packaged America-only source rows from discovery controls.

Common environment variables:

- `JOBHUNTER_DIR`: override the local app directory.
- `GEMINI_API_KEY`, `OPENAI_API_KEY`, or `LLM_URL`: configure LLM access.
- `LLM_MODEL`: choose the model for the configured provider.
- `CHROME_PATH`: override Chrome/Chromium detection.
- `PDFLATEX_PATH`: override LaTeX detection.
- `CAPSOLVER_API_KEY`: enable CAPTCHA solving support.
- `JOBHUNTER_API_HOST`, `JOBHUNTER_API_PORT`: local TypeScript API bind
  settings.
- `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`:
  enable OpenTelemetry export of LLM, workflow, and JSON-RPC spans to a
  Langfuse instance. When any of these is unset the worker runs normally
  without exporting. Set `LANGFUSE_DISABLE=1` to opt out even when
  credentials are present. Enabling this exports every LLM prompt and
  completion to the configured Langfuse instance.
- `LANGFUSE_OTEL_TIMEOUT_SECONDS`: optional OTLP/HTTP export timeout for
  Langfuse; defaults to `5.0`.

## Development

Install dependencies:

```bash
corepack pnpm install
uv --project workers/automation sync --extra dev
```

Run the standard checks:

```bash
pnpm check
pnpm test
uv --project workers/automation run --extra dev python -m build workers/automation
git diff --check
```

Useful focused checks:

```bash
pnpm api:check
pnpm api:test
pnpm qa:test
pnpm web:check
pnpm web:build
uv --project workers/automation run --extra dev pytest workers/automation/tests/test_state_dashboard.py -q
```

Seed a disposable local QA workspace when you need to exercise destructive UI
flows without touching `~/.jobhunter`:

```bash
pnpm qa:seed -- /tmp/jobhunter-qa
JOBHUNTER_DIR=/tmp/jobhunter-qa pnpm api:dev
VITE_JOBHUNTER_API_BASE_URL=http://127.0.0.1:8766 pnpm web:dev -- --port 5173
```

Build the Python package:

```bash
uv --project workers/automation run --extra dev python -m build workers/automation
```

## Project Status

The near-term priority is local reliability:

- make per-stage state canonical;
- keep retries targeted and observable;
- keep generated artifacts registered before the UI opens them;
- keep dry-run apply behavior safe;
- keep product-facing behavior in the TypeScript API and current React/Vite
  shell while steering frontend architecture toward TanStack Router and
  TanStack Query.

Hosted accounts, billing, object storage, Postgres migration, hosted workers,
and SaaS deployment are intentionally deferred until the local workflow is
reliable.

## Documentation Map

- `docs/README.md`: documentation index.
- `docs/architecture.md`: current architecture and runtime boundaries.
- `docs/domain-model.md`: domain language and ownership rules.
- `docs/local-development.md`: setup, run, build, test, and lint commands.
- `docs/local-ts-api.md`: local API and web development notes.
- `docs/local-reliability-qa.md`: local QA checklist and regression matrix.
- `docs/decisions.md`: accepted architecture decisions.
- `docs/delivered.md`: delivery history by PR.
- `docs/backlog.md`: deferred local and hosted work.
- `docs/plans/`: proposed and implemented feature plans.

## License

JobHunter is licensed under AGPL-3.0-only.
