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

- `services/api`: local TypeScript/Fastify API for typed read models, local
  product actions, profile/settings, artifacts, and worker invocation.
- `apps/web`: current React/Vite local web shell; planned direction is
  TanStack Router plus TanStack Query as the UI grows beyond the shell.
- `src/jobhunter`: Python automation engine, CLI, workers, profile import, PDF
  creation, and apply automation.

## Safety And Data

By default, JobHunter writes user data under:

```text
~/.jobhunter/
```

Important local files include:

- `profile.json`: structured candidate and application data.
- `searches.yaml`: search targets and discovery configuration.
- `.env`: API keys and local runtime settings.
- `jobhunter.db`: local SQLite database.
- `resume_template.tex` and `resume_style.json`: PDF rendering inputs.
- `tailored_resumes/`, `cover_letters/`, `logs/`: generated artifacts.
- `chrome-workers/`, `apply-workers/`: local browser/apply worker state.

Do not commit profile data, keys, generated resumes, cover letters, PDFs,
browser profiles, logs, or SQLite databases.

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

Local API and web UI:

- Node.js 20.19 or newer.

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
uv sync
uv run jobhunter doctor
```

For development of the local TypeScript API and current React/Vite shell:

```bash
npm install
npm test
```

Discovery can use `python-jobspy` when installed. If `jobhunter doctor` reports
that JobSpy is missing, install it with the command shown by the doctor output.

## First-Time Setup

Create your local profile and configuration:

```bash
uv run jobhunter init
uv run jobhunter doctor
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
uv run jobhunter run
```

Run specific stages:

```bash
uv run jobhunter discover
uv run jobhunter enrich
uv run jobhunter score --workers 4
uv run jobhunter tailor --workers 4 --min-score 7
uv run jobhunter cover --min-score 7
uv run jobhunter pdf
```

Run stages by name through the orchestrator:

```bash
uv run jobhunter run discover enrich score
uv run jobhunter run tailor cover pdf --validation normal
uv run jobhunter run --stream
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
uv run jobhunter job https://example.com/job/123 --tailor --dry-run
uv run jobhunter job https://example.com/job/123 --tailor
uv run jobhunter job https://example.com/job/123 --apply --dry-run
```

Reset one stage for one job:

```bash
uv run jobhunter retry score https://example.com/job/123
uv run jobhunter retry tailor https://example.com/job/123 --reset-attempts
```

`retry --run` can process other eligible pending work for some stages. Use it
deliberately.

## Auto-Apply

Auto-apply launches local browser workers and can submit applications. Start
with dry runs and narrow targets:

```bash
uv run jobhunter apply --dry-run --limit 1
uv run jobhunter apply --url https://example.com/job/123 --dry-run
```

Run apply for prepared jobs:

```bash
uv run jobhunter apply --limit 5
uv run jobhunter apply --workers 3 --min-score 8
```

Utility modes:

```bash
uv run jobhunter apply --gen --url https://example.com/job/123
uv run jobhunter apply --mark-applied https://example.com/job/123
uv run jobhunter apply --mark-failed https://example.com/job/123 --fail-reason "manual review"
uv run jobhunter apply --reset-failed
```

Auto-apply requires a prepared profile, generated materials, Chrome/Chromium,
Node.js, and Claude Code CLI.

## Structured Local Actions

The CLI also exposes a JSON-returning action surface used by local UI paths:

```bash
uv run jobhunter action score --limit 5 --dry-run
uv run jobhunter action apply --url https://example.com/job/123 --dry-run
uv run jobhunter action profile_import --pdf ~/resume.pdf --dry-run
```

These actions record start and finish events where possible and return
structured success or failure data.

## Local UI

Run the local TypeScript API:

```bash
npm run api:dev
```

Run the current React/Vite web shell:

```bash
npm run web:dev
```

The Vite dev server proxies `/v1/*` to the local API by default. Set
`VITE_JOBHUNTER_API_BASE_URL` when the API runs on a different local origin.

## Inspecting Progress

Show pipeline counts:

```bash
uv run jobhunter status
```

Inspect recent apply runs:

```bash
uv run jobhunter runs
uv run jobhunter runs --failed-only
uv run jobhunter runs --run-id <prefix>
```

The normalized stage states are stored in `job_stage_states`, and events are
stored in `job_events`. Prefer the local UI/API and CLI over direct SQLite
edits.

## Configuration

JobHunter uses local user configuration plus package-shipped registries:

- `~/.jobhunter/profile.json`: candidate data, application defaults, resume
  baseline, tailoring controls.
- `~/.jobhunter/searches.yaml`: searches and source settings.
- `~/.jobhunter/.env`: provider keys and runtime environment.
- `src/jobhunter/config/employers.yaml`: packaged employer registry.
- `src/jobhunter/config/sites.yaml`: packaged site and ATS behavior settings.
- `src/jobhunter/config/searches.example.yaml`: example search file.

Common environment variables:

- `JOBHUNTER_DIR`: override the local app directory.
- `GEMINI_API_KEY`, `OPENAI_API_KEY`, or `LLM_URL`: configure LLM access.
- `LLM_MODEL`: choose the model for the configured provider.
- `CHROME_PATH`: override Chrome/Chromium detection.
- `PDFLATEX_PATH`: override LaTeX detection.
- `CAPSOLVER_API_KEY`: enable CAPTCHA solving support.
- `JOBHUNTER_API_HOST`, `JOBHUNTER_API_PORT`: local TypeScript API bind
  settings.

## Development

Install dependencies:

```bash
npm install
uv sync --extra dev
```

Run the standard checks:

```bash
npm test
uv run --extra dev pytest -q
uv run --extra dev ruff check .
git diff --check
```

Useful focused checks:

```bash
npm run api:check
npm run api:test
npm run qa:test
npm run web:check
npm run web:build
uv run --extra dev pytest tests/test_state_dashboard.py -q
```

Seed a disposable local QA workspace when you need to exercise destructive UI
flows without touching `~/.jobhunter`:

```bash
npm run qa:seed -- /tmp/jobhunter-qa
JOBHUNTER_DIR=/tmp/jobhunter-qa npm run api:dev
VITE_JOBHUNTER_API_BASE_URL=http://127.0.0.1:8766 npm run web:dev -- --port 5173
```

Build the Python package:

```bash
uv run --extra dev python -m build
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

- `docs/ARCHITECTURE.md`: current architecture and runtime boundaries.
- `docs/DOMAIN_MODEL.md`: domain language and ownership rules.
- `docs/DECISIONS.md`: accepted architecture decisions.
- `docs/DELIVERED.md`: delivery history by PR.
- `docs/BACKLOG.md`: deferred local and hosted work.
- `docs/plans/`: proposed and implemented feature plans.

## License

JobHunter is licensed under AGPL-3.0-only.
