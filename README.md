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
- Enrich postings with full descriptions, canonical posting URLs, and apply URLs.
- Score jobs as an applicant-side triage aid with auditable evidence.
- Generate tailored resumes, cover letters, PDFs, and review artifacts.
- Review and edit generated resumes in Apply Review before approval.
- Edit resume PDF style templates in Preferences, choose a default template, and
  override the template per job without modifying candidate profile data.
- Track pipeline state, failures, retries, workflow runs, artifacts, and apply
  history in a local web UI.
- Optionally run browser-based apply automation, starting with dry runs.

Auto-apply is powerful and must be treated as an explicit submission tool. Use
dry-run paths and narrow targets before allowing it to submit anything.

## Current System

JobHunter has three local runtime components:

- `apps/api`: local TypeScript/Fastify API for read models, profile/settings,
  structured actions, artifacts, and worker dispatch.
- `apps/web`: React/Vite app using TanStack Router, Query, Table, and Form with
  SSE-backed cache invalidation.
- `workers/automation`: Python automation engine, CLI, Temporal worker,
  discovery, scoring, materials, PDF rendering, and apply automation.

SQLite and local files are the source of truth. Hosted accounts, billing,
managed browsers, object storage, and SaaS deployment are deferred; see
[ROADMAP.md](ROADMAP.md).

## Quick Start

Requirements:

- Python 3.11+
- Node.js 20.19+
- pnpm through Corepack
- uv
- Temporal CLI with `temporal server start-dev`
- Playwright Chromium for HTML/CSS PDF rendering
- an LLM provider key or local LLM endpoint for scoring and materials

Install and run:

```bash
git clone https://github.com/ebarti/JobHunter.git
cd JobHunter
pnpm dev:setup
uv --project workers/automation run jobhunter init
uv --project workers/automation run jobhunter doctor
pnpm dev
```

`pnpm dev` starts the full local stack in the foreground: Temporal dev server,
TypeScript API, Vite web app, and Python worker. Keep the terminal open while
using the app and stop it with Ctrl-C.

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

Never commit profiles, API keys, generated resumes, cover letters, PDFs, browser
profiles, logs, SQLite databases, screenshots containing real data, or local
worker state. See [docs/user/data-and-safety.md](docs/user/data-and-safety.md)
and [SECURITY.md](SECURITY.md).

## Normal Flow

1. Create or import a candidate profile.
2. Configure target roles, locations, work models, and application preferences.
3. Run Discover from the UI or CLI.
4. Review jobs, scores, blockers, compensation evidence, and audit history.
5. Generate or inspect materials for promising jobs.
6. Use Apply Review to edit/approve the resume and review comments.
7. Run apply dry-runs before approving any real browser submission.
8. Track progress in Dashboard, Jobs, Runs, Artifacts, Apply Review, and Debug.

See [docs/user/normal-flows.md](docs/user/normal-flows.md) for commands and
expected state transitions.

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
- `JOBHUNTER_RESUME_RENDERER=latex_pdf`: opt into the legacy LaTeX resume
  renderer. The default is HTML/CSS printed by Playwright.
- `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`: optional
  OpenTelemetry/Langfuse export. Set `LANGFUSE_DISABLE=1` to opt out.

## Development

```bash
pnpm dev:setup
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
uv --project workers/automation run --extra dev pytest -q
```

For contributor workflow, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- [docs/user/](docs/user/): end-user setup, configuration, normal flows, and
  safety.
- [docs/developer/](docs/developer/): contributor onboarding and architecture
  reading path.
- [docs/architecture.md](docs/architecture.md): current runtime architecture.
- [docs/job-pipeline-architecture.md](docs/job-pipeline-architecture.md):
  phase-by-phase pipeline sequence and class diagrams.
- [docs/local-reliability-qa.md](docs/local-reliability-qa.md): regression
  matrix and QA gates.
- [docs/decisions.md](docs/decisions.md): accepted architecture decisions.
- [docs/delivered.md](docs/delivered.md): delivery history.
- [docs/backlog.md](docs/backlog.md): detailed engineering backlog.
- [docs/plans/](docs/plans/): historical proposal and implementation records.

## License

JobHunter is licensed under AGPL-3.0-only. See [LICENSE](LICENSE).
