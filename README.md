# JobHunter

JobHunter is a local-first job search automation system. It keeps your profile,
job database, generated materials, browser state, and logs on your machine while
helping you move jobs through the user-facing pipeline:

```text
discover -> apply
```

Discovery also drains the internal preparation work needed before applying,
including enrichment, scoring, resume tailoring, and artifact suppression.
Those lower-level stages remain available as maintenance and diagnostic
commands.

The automation engine is Python. The newer product surface is a local
TypeScript API plus a React/Vite web shell. The intended frontend direction is
TanStack Router for client-side routing plus TanStack Query for API/cache state
management. SQLite and local files remain the source of truth while the project
validates reliability before any hosted/SaaS hardening.

## What It Does

JobHunter can:

- find jobs from configured searches and supported source registries, then
  enrich matching jobs with full descriptions and application URLs;
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
  jobs, discovery settings, events, projections, and artifact metadata.
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
  environment variables. Gemini keys default to `gemini-3.5-flash` unless
  `LLM_MODEL` overrides the model.
- A TeX distribution with `pdflatex` for PDF output.
- Temporal CLI with dev server support (`temporal server start-dev`) for the
  workflow engine the Python worker runs against. The local dev launcher starts
  it for you with persistent local workflow history; see
  `docs/local-development.md`.

Local API and web UI:

- Node.js 20.19 or newer.
- pnpm through Corepack.

Auto-apply:

- Chrome or Chromium.
- Node.js and `npx` for the Playwright MCP runtime.
- Claude Code CLI for browser-driven form completion.
- Optional Gmail connector auth for read-only email verification codes.
- Optional `CAPSOLVER_API_KEY` for CAPTCHA solving.

Run the doctor command after setup. It is the fastest way to see which tier of
functionality is available on your machine.

## Install From Source

```bash
git clone https://github.com/ebarti/JobHunter.git
cd JobHunter
pnpm dev:setup
uv --project workers/automation run jobhunter doctor
```

Start the full local dev stack for UI/API job runs:

```bash
pnpm dev
```

`pnpm dev:setup` installs the Node workspace dependencies and syncs the
uv-managed Python automation environment, including `python-jobspy` and its
locked transitive dependencies plus the Python dev extras used by local checks.
`pnpm dev` runs the process supervisor in the foreground and also invokes the
Python worker through `uv run`, which re-syncs the worker environment if needed.
Keep that terminal open while using the app and stop it with Ctrl-C. First-time
setup should use `pnpm dev:setup` so dependency failures are separated from
process startup.

For verification:

```bash
pnpm test
```

Discovery includes `python-jobspy` for broad-board scraping through JobSpy.
If `jobhunter doctor` reports JobSpy is missing, rerun
`uv --project workers/automation sync`.

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

Run the default preparation pipeline:

```bash
uv --project workers/automation run jobhunter run
```

Run specific low-level maintenance stages:

```bash
uv --project workers/automation run jobhunter discover
uv --project workers/automation run jobhunter score --workers 4
uv --project workers/automation run jobhunter tailor --workers 4 --min-score 7
uv --project workers/automation run jobhunter cover --min-score 7
```

Run low-level stages by name through the orchestrator:

```bash
uv --project workers/automation run jobhunter run discover score
uv --project workers/automation run jobhunter run tailor cover --validation normal
uv --project workers/automation run jobhunter run --stream
```

`jobhunter enrich` remains available as a diagnostic queue-drain command, but
normal discovery runs own detail enrichment.

Useful options:

- `--dry-run`: preview a stage without executing it.
- `--workers` / `-w`: parallelize supported stages.
- `--limit`: cap eligible records for supported single-stage commands.
- `--min-score`: control which scored jobs proceed to materials or apply.
- `--validation strict|normal|lenient`: tune tailoring and cover-letter checks.
- `--retailor`: regenerate tailored resumes for jobs that already have one.
- `--tailor-models`: comma-separated tailoring generator model specs such as
  `local:draft-a,gemini:gemini-3.5-flash`; omit it to use the existing
  `LLM_MODEL`/provider default.
- `--tailor-judge-model`: optional separate model spec for the structured
  tailoring judge. This is independent of the apply `--model` option.
- `--tailor-judge-min-score`: minimum structured judge score for approval
  (`0.82` by default). `--validation lenient` skips the judge.

For high-fit jobs (fit score `8+`), a resume that passes deterministic
validation and the structured judge is also checked by adversarial reviewer
personas. Blocker findings keep the resume unapproved and feed the retry loop
instead of being hidden as a successful tailoring run.

The same tailoring controls can be provided through
`TAILORING_GENERATOR_MODELS`, `TAILORING_JUDGE_MODEL`, and
`TAILORING_JUDGE_MIN_SCORE`. The shorter aliases `TAILOR_LLM_MODELS`,
`TAILOR_JUDGE_MODEL`, and `TAILOR_JUDGE_MIN_SCORE` are also accepted. Model
specs name only a provider/model (`gemini:...`, `openai:...`, or `local:...`);
credentials and local endpoint URLs still come only from environment variables
and are not written to artifact metadata.

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

In the local web UI, dashboard KPIs open matching Jobs filters. Failures opens
failed jobs so you can retry selected failures or retry all currently matching
failed jobs after confirmation. A retry from a job detail drawer resumes the
remaining preparation pipeline for that job (`enrich` -> `score` -> `tailor` ->
`cover`, starting at the retried stage); application submission remains a
separate explicit action. Applied opens the jobs with an actual applied outcome
(`applied_at` present or apply status `applied`), not a synthetic pipeline
state.

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
Node.js, and Claude Code CLI. Jobs can start from a direct application URL
when enrichment finds one, or from the original posting URL when the local
agent needs to click through to the employer form. The default model is
`default`, which lets Claude Code use its configured local model; pass
`--model <name>` only when you want to override that local default.

The local API and web app also record apply-review decisions and application
outcomes. The web `/apply-review` queue shows active apply-stage jobs with
materials readiness, latest apply-run context, blockers, review decisions, and
pending outcome suggestions. Job details include a local outcome timeline and
manual outcome form. `approve_submit` is an approval fact only; it does not
start browser submission by itself. Manual outcomes can include local notes in
SQLite, but event payloads contain only safe identifiers, outcome kinds, and
presence flags.

Gmail outcome feedback is a separate read-only scan from the verification-code
MCP server. `POST /v1/outcomes/gmail/scan` asks the worker to search bounded
post-application windows for known application anchors only, using the
candidate recipient email plus employer, ATS, title/company, and application
URL/domain hints. JobHunter reads and stores a full Gmail body only after the
metadata is confidently linked to one known application. Linked evidence stays
in local SQLite with body text and a body hash; API responses, event payloads,
logs, and broad projections expose only safe evidence/suggestion identifiers,
kinds, confidence values, and link signals.

Applications that send verification codes by email use JobHunter's first-party,
read-only Gmail connector. Put a Google OAuth Desktop client file at
`~/.jobhunter/gmail/oauth-client.json`, then authenticate once:

```bash
uv --project workers/automation run jobhunter gmail-auth
uv --project workers/automation run jobhunter doctor
```

The connector requests only the `gmail.readonly` OAuth scope and stores the
token at `~/.jobhunter/gmail/token.json`. `jobhunter doctor` reports `Gmail
connector auth`. Without authenticated Gmail,
auto-apply stops with `RESULT:LOGIN_ISSUE` when an application requires an
email verification code. Override long ATS timeouts with
`JOBHUNTER_APPLY_TIMEOUT_SECONDS=<seconds>` in `~/.jobhunter/.env`.

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

Start the full local development stack:

```bash
pnpm dev
```

That launches the Temporal dev server, local TypeScript API, React/Vite web app,
and JobHunter Temporal worker in the foreground. Before each component starts,
the launcher stops the previous tracked JobHunter process tree for that
component, so rerunning `pnpm dev` starts from a clean owned stack. Keep the
terminal open and use Ctrl-C to stop the stack. The launcher defaults to
`~/.jobhunter`,
`127.0.0.1:8766` for the API, and `127.0.0.1:5173` for the web app. Inspect the
stack from another terminal with:

```bash
pnpm dev:status
pnpm dev:logs worker
```

For a detached background stack, use the explicit daemon mode:

```bash
pnpm dev:start
pnpm dev:stop
```

The API health endpoint reports the API app/database identity and the latest
Temporal worker heartbeat. The web topbar alerts when the worker is missing or
stale, and pipeline stage buttons stay disabled until the worker is
heartbeating against the same local database.

Temporal workflow history is persisted under `.dev/temporal/temporal.db` by
default so local debugging can survive launcher restarts. Override
`JOBHUNTER_TEMPORAL_DB` when a separate Temporal dev store is needed.

For troubleshooting, run individual components in separate terminals:

```bash
temporal server start-dev --db-filename .dev/temporal/temporal.db
pnpm api:dev
pnpm web:dev
uv --project workers/automation run jobhunter worker
```

The Vite dev server proxies `/v1/*` to the local API by default. Set
`VITE_JOBHUNTER_API_BASE_URL` when the API runs on a different local origin.

The Jobs tab can filter by stage, state, and fit-score range. Its source column
shows the posting owner and the discovery source separately when available, so
broad-board results can be distinguished from canonical employer or ATS sources.

The Jobs tab separates posting lifecycle state from manual suppression. Closed
jobs are postings the system verified as unavailable, expired, removed, or
location-incompatible; they move to the Closed tab instead of staying in the
active dashboard or worker queues. Deleting a job moves it to the Deleted tab; a
later discovery run can resurface that job if the posting is found again. Hiding
a job moves it to the Hidden tab and keeps it hidden across future discovery
runs until you select it there and use **unhide selected**. Deleted and hidden
rows can also be permanently deleted from the local database; discovery can add
the same posting again later because that action clears the delete/hide
tombstones instead of creating a new suppression record.

The Pipelines tab exposes the product-stage starts for `discover` and `apply`.
Discover owns preparation and Apply owns browser automation; lower-level
`enrich`, `score`, `tailor`, and `cover` remain CLI/API maintenance and
diagnostic surfaces rather than product tabs. Each product tab keeps persisted
local config and only shows controls that the selected stage actually consumes.
Running a tab submits that stage through the local API. The panel reports when
the request is waiting on the local worker, whether the start was queued,
completed, dry-run, or failed, and the returned run/action id when one is
available. Queued or running Discover and Apply workflows expose stop controls
from the Pipelines and Workflow Runs views, and active per-job apply runs can be
stopped from Apply review when a latest apply run is attached to the job.
Jobs whose first-time tailoring is skipped by the default low-fit gate can still
be tailored explicitly from the job detail tailor stage. Re-tailor controls are
reserved for jobs that already have tailored artifacts and need current-policy
regeneration.
Longer-running progress appears in the dashboard pipeline and
apply-runs cards, while the Debug tab owns the paginated Recent activity table
for event-level inspection. Non-apply stages emit pipeline lifecycle events;
Discover also emits source-step events and scheduled discovery-run events for
JobSpy, Workday, and Smart Extract so a stuck or low-quality source is visible
before the request finishes. Long JobSpy crawls also persist source-level
progress, including completed search combinations, current query/location, new
rows, duplicates, filtered rows, errors, and raw observed rows. Stopping a
running Discover workflow marks the matching source run terminal so the
dashboard does not keep reporting an old crawl as active. The dashboard
source-health card summarizes the
local source-quality projection used to budget and demote future crawls. The
Discovery page owns the local source registry, source locator candidates,
observed-source preview, quarantined leads, and manual-capture queue. Its source
registry tab renders sources as a filterable, sortable table with company,
source id, source type, state, priority, recommendation, activity, run health,
and quality-metric columns. Located parseable sources are automatically approved
into the active source registry; manual review is reserved for blocked,
ambiguous, or unparseable sources. JobSpy broad-board results can also learn
durable sources: when a result exposes a direct owner URL, JobHunter records the
board provenance, links the job to the canonical posting URL, and promotes
runnable ATS sources into the registry; unknown owner URLs and ATS URLs that
still need adapter configuration stay in review. These controls can add an
experimental source, preview recently observed leads for a source, enable or
quarantine a source, approve or reject quarantined leads, record source
feedback, review low-score role-match suggestions, approve or decline exact
title-exclusion rules for future discovery, open a blocked lead in the local
browser, and import a user-provided URL, current-page URL, pasted text, saved
HTML, or email content as manual-capture provenance. Manual capture stores
local provenance metadata and content hashes, not raw captured posting text in
domain events. The `limit` control is honored by the Discover and Apply tabs; a
bounded Discover run stops
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
  defaults, discovery settings, resume baseline, tailoring controls, rendering
  settings, jobs, events, and projections.
- `~/.jobhunter/profile.json`: legacy seed path for first-time import when the
  profile tables are empty.
- `~/.jobhunter/.env`: provider keys and runtime environment.
- `workers/automation/src/jobhunter/config/employers.yaml`: packaged employer registry.

Profile, Preferences, Discovery target search, and Settings forms autosave five
seconds after the last edit through the same local API mutations as the Save
buttons. Checkbox, select, and other non-text setting controls keep an
in-session undo history for Ctrl+Z / Cmd+Z.

Preferences includes resume tailoring controls for claim mode, auto-approvable
claim modes, adjacent achievement drafts, writing style, and custom tailoring
instructions. Profile experience entries include achievement evidence fields
for source text, scope, action, tools, metrics, outcome, seniority signal,
evidence strength, claim confidence, and user confirmation. Only verified facts
and evidence reframing can be auto-approved; adjacent translations and draft
claims remain review material.
- `workers/automation/src/jobhunter/config/sites.yaml`: packaged site and ATS behavior settings.

Discovery runtime settings are edited on the Discovery page and stored in the
SQLite `discovery_settings` table. JobSpy board selection uses the `boards`
field in that row, and target roles/locations from the Discovery target-search
form are overlaid by the worker before any source persists jobs.

The legacy `sites` key is still accepted for the compatibility window and logs
a warning instead of failing. When both keys are present, `boards` wins. The
worker also builds a local source registry contract from packaged
`sites.yaml`, `employers.yaml`, and the selected JobSpy boards; migrated
Smart Extract entries start as `experimental` with the
`smart_extract_experimental` policy so existing arbitrary-site discovery keeps
working while sources are promoted or rejected.

The Discovery page's Target search settings are discovery inputs. Target roles
stay as explicit guidance and replace the active discovery query list with exact
role queries. Target tracks are normalized to IC, management, and executive;
seniority floors use the engineering ladder choices shown in Discovery settings.
Target tracks, seniority floors, role areas, and specializations add structured intent;
resume import can suggest these fields conservatively but does not overwrite
existing user choices. The worker expands that intent into deterministic recall
queries. Recall queries keep the same search tier as exact queries because
relevance is determined after discovery by scoring, not by query generation.
Recall title matching enforces candidate seniority and track: IC targets stay
IC, management targets stay management, executive targets stay executive, and
mixed profiles can opt into multiple tracks explicitly. Broad-board providers
such as JobSpy use exact and recall queries as retrieval probes. Direct ATS,
Workday, and source-first Smart Extract sources enumerate their known
board/source and apply the same
exact-plus-recall title intent internally, avoiding repeated board fetches for
each role variant. Smart Extract search-only sources still fan out by query when
the source has no useful browse/all-jobs page. Canonical ATS rows must include a
usable description before insertion; Greenhouse reads the public board content
payload instead of creating blank-description rows. Each discovery run also
checks discovered postings for staleness: verified unavailable, expired,
removed, or location-incompatible postings move to Closed, while active jobs
that no longer satisfy the current title, location, or description contract are
soft-deleted instead of remaining visible. Target locations replace the active
location list, and if target locations are blank
the worker falls back to the profile city/country. Target locations are
validated as real places before they can be saved. Hybrid and on-site target
work models search and filter only the target location. Remote target work
models search and filter the target country, and European countries also add an
Europe-remote search and accept pattern. Profile-driven discovery searches at
least the last 30 days unless local config sets a larger window. A Spain or
Europe target sets JobSpy's Indeed country to Spain, rejects America-only
non-remote locations, and hides packaged America-only source rows from discovery
controls. Discovery `limit` is a new-job budget: already-seen jobs record
observations but do not consume the cap.
Title matching uses deterministic exact/alias checks first. When a posting only
matches a target role loosely and an LLM provider is configured, discovery asks
the LLM to adjudicate the role family, primary function, seniority, and track
before keeping the row. This prevents broad-board keyword overlap such as
finance, vendor, construction, project, product, or sales manager titles from
entering engineering, platform, security, IT, or technology leadership queues
just because they contain one target keyword.

Common environment variables:

- `JOBHUNTER_DIR`: override the local app directory.
- `GEMINI_API_KEY`, `OPENAI_API_KEY`, or `LLM_URL`: configure LLM access.
- `LLM_MODEL`: choose the model for the configured provider. Gemini defaults to
  `gemini-3.5-flash`.
- Pipeline scoring, resume tailoring, and cover-letter generation default to
  the explicit model spec `gemini:gemini-3.5-flash`; stage-specific tailoring
  model variables below override that pipeline default.
- `JOBHUNTER_DISCOVERY_LLM_ROLE_FILTER`: controls LLM adjudication for loose
  discovery title matches. Defaults to `auto`, which enables the check when an
  LLM provider is configured. Set `0` to force deterministic title matching.
- `JOBHUNTER_DISCOVERY_ROLE_FILTER_MODEL`: optional model spec for discovery
  role adjudication; defaults to the configured LLM model.
- `TAILORING_GENERATOR_MODELS`: optional comma-separated generator model specs
  for resume tailoring.
- `TAILORING_JUDGE_MODEL`: optional separate judge model spec for resume
  tailoring.
- `TAILORING_JUDGE_MIN_SCORE`: optional quality threshold for judge approval.
- `CHROME_PATH`: override Chrome/Chromium detection.
- `PDFLATEX_PATH`: override LaTeX detection.
- `CAPSOLVER_API_KEY`: enable CAPTCHA solving support.
- `JOBHUNTER_APPLY_TIMEOUT_SECONDS`: per-job auto-apply agent timeout
  (`900` seconds by default).
- `JOBHUNTER_GMAIL_DIR`, `JOBHUNTER_GMAIL_OAUTH_CLIENT_PATH`,
  `JOBHUNTER_GMAIL_TOKEN_PATH`: override the first-party Gmail connector auth
  directory, OAuth client file, or token file.
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
pnpm dev:setup
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
JOBHUNTER_DIR=/tmp/jobhunter-qa pnpm dev
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

- `docs/INDEX.md`: documentation index.
- `docs/architecture.md`: current architecture and runtime boundaries.
- `docs/job-pipeline-architecture.md`: detailed phase-by-phase job pipeline
  execution diagrams and call paths.
- `docs/ddd-target.md`: canonical DDD target, domain language, and ownership rules.
- `docs/local-development.md`: setup, run, build, test, and lint commands.
- `docs/local-ts-api.md`: local API and web development notes.
- `docs/local-reliability-qa.md`: local QA checklist and regression matrix.
- `docs/decisions.md`: accepted architecture decisions.
- `docs/delivered.md`: delivery history by PR.
- `docs/backlog.md`: deferred local and hosted work.
- `docs/plans/`: proposed and implemented feature plans.

## License

JobHunter is licensed under AGPL-3.0-only.
