# Technology Stack

**Analysis Date:** 2026-06-08

## Stack At A Glance

JobHunter is a local-first monorepo with a TypeScript product surface and a Python automation engine.

- Local API: `apps/api` is a Fastify app that reads and writes local SQLite projections and dispatches complex work to Python.
- Local web app: `apps/web` is a React/Vite single-page app with TanStack Router, Query, Table, and Form.
- Shared TypeScript packages: `packages/contracts`, `packages/domain-types`, `packages/api-client`, and `packages/tsconfig`.
- Automation worker: `workers/automation/src/jobhunter` is a uv-managed Python package with a Typer CLI, Temporal worker, JSON-RPC server, scraping, LLM, PDF, and apply automation.
- Local source of truth: SQLite plus local files under `~/.jobhunter`; see `README.md` and `workers/automation/src/jobhunter/config.py`.

## Languages

**Primary:**
- TypeScript / TSX - API, web UI, shared contracts, typed API client, and frontend tests in `apps/api`, `apps/web`, and `packages`.
- Python >=3.11 - automation engine, CLI, worker activities, domain model, repositories, and scraping/apply adapters in `workers/automation/src/jobhunter`.

**Secondary:**
- Bash - local dev fleet launcher in `scripts/dev`.
- YAML - packaged source registries in `workers/automation/src/jobhunter/config/sites.yaml` and `workers/automation/src/jobhunter/config/employers.yaml`; GitHub Actions in `.github/workflows`.
- SQL - SQLite schemas and projection tables are embedded in `workers/automation/src/jobhunter/database.py`, `apps/api/src/projections.ts`, and related repository modules.

## Runtime

**Node / TypeScript:**
- Node.js >=20.19.0, declared in `package.json`.
- Package manager: pnpm 10.24.0 through Corepack, declared in `package.json`.
- Workspace layout: `pnpm-workspace.yaml` includes `apps/*` and `packages/*`.
- Lockfile: `pnpm-lock.yaml`.

**Python:**
- Python >=3.11, declared in `workers/automation/pyproject.toml`.
- Package manager/runtime: uv, used by root scripts and `scripts/dev`.
- Lockfile: `workers/automation/uv.lock`.
- Python package entry point: `jobhunter = "jobhunter.cli:app"` in `workers/automation/pyproject.toml`.

**Local processes:**
- `pnpm dev` runs the local fleet through `scripts/dev`: Temporal dev server, API, web app, and worker.
- API process: `apps/api/src/main.ts` listens on `JOBHUNTER_API_HOST` / `JOBHUNTER_API_PORT`, defaulting to `127.0.0.1:8766`.
- Web process: `apps/web/vite.config.ts` serves on port `5173` and proxies `/v1` to the API.
- Worker process: `uv --project workers/automation run jobhunter worker` starts Temporal workflows and activities registered in `workers/automation/src/jobhunter/infrastructure/temporal/registry.py`.

## Frameworks And Libraries

**API (`apps/api`):**
- Fastify 5.8.5 - HTTP server in `apps/api/src/server.ts`.
- `@fastify/cors` 11.2.0 - loopback CORS allow-list in `apps/api/src/server.ts` and `apps/api/src/local-origin.ts`.
- `better-sqlite3` 12.9.0 - synchronous SQLite access in `apps/api/src/db.ts`.
- Zod 4.4.x - request and response validation through `apps/api/src/contracts.ts` and `packages/contracts`.
- `tsx` 4.21.0 - TypeScript dev/start runtime for `apps/api`.

**Web (`apps/web`):**
- React 19.2.x and React DOM 19.2.x - UI runtime in `apps/web/src/main.tsx`.
- Vite 7.3.x - bundler/dev server in `apps/web/vite.config.ts`.
- Tailwind CSS 4.2.x with `@tailwindcss/vite` - CSS-first styling through `apps/web/src/styles/globals.css`, `apps/web/src/styles/tokens.css`, and `apps/web/components.json`.
- TanStack Router 1.169.x - file-based routing through `apps/web/src/routes` and `apps/web/src/router.ts`.
- TanStack Query 5.100.x - server state through hooks in `apps/web/src/contexts/operations/hooks`.
- TanStack Table 8.21.x - table views such as `apps/web/src/views/jobs/columns.tsx`.
- TanStack Form 1.29.x - form surfaces in `apps/web/src/contexts/profile/forms`.
- Zustand 5.0.x - client state stores in `apps/web/src/shared/stores` and context stores.
- Radix primitives / shadcn-owned components - copied UI primitives in `apps/web/src/shared/ui`.
- pdfjs-dist 5.7.x - PDF preview support through `apps/web/src/shared/ui/PdfPreviewViewer.tsx`.

**Python worker (`workers/automation`):**
- Typer 0.24.1 and Rich 14.3.3 - CLI in `workers/automation/src/jobhunter/cli.py`.
- Temporal Python SDK 1.26.0 - workflow orchestration under `workers/automation/src/jobhunter/infrastructure/temporal`.
- httpx 0.28.1 - LLM, Gmail, OAuth, and observability checks.
- Playwright 1.58.0 - browser/page scraping, PDF rendering, LinkedIn resolver, and local apply flows.
- python-jobspy 1.1.82 - broad job-board scraping in `workers/automation/src/jobhunter/discovery/jobspy.py`.
- BeautifulSoup 4.14.3 - HTML parsing in enrichment, ATS adapters, and Smart Extract.
- pandas 2.3.3 - JobSpy result handling.
- pypdf 6.10.2 - resume/profile import support.
- PyYAML 6.0.3 - packaged source registry loading.
- python-dotenv 1.2.2 - env loading from local app/root `.env` files in `workers/automation/src/jobhunter/config.py`.
- OpenTelemetry 1.41.x and HTTPX instrumentation 0.62b1 - Langfuse OTLP export in `workers/automation/src/jobhunter/infrastructure/observability`.

## Key Dependencies

**Critical TypeScript dependencies:**
- `@jobhunter/contracts` - shared DTOs, Zod schemas, JSON-RPC envelopes, and re-exported domain types in `packages/contracts/src`.
- `@jobhunter/domain-types` - TypeScript mirror of Python domain concepts in `packages/domain-types/src`.
- `@jobhunter/api-client` - typed fetch client in `packages/api-client/src/client.ts`.
- `fastify` + `better-sqlite3` - local API and projection-backed read model.
- TanStack Router / Query / Table / Form - frontend routing, server state, tables, and forms.

**Critical Python dependencies:**
- `temporalio` - local workflow engine integration.
- `httpx` - provider HTTP client and API probes.
- `playwright` - browser automation and scraping.
- `python-jobspy` - broad-board discovery.
- `opentelemetry-*` - worker observability export.

## Configuration

**Repository configuration files:**
- Root package and scripts: `package.json`.
- Workspace definition: `pnpm-workspace.yaml`.
- API package config: `apps/api/package.json`, `apps/api/tsconfig.json`.
- Web package config: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/vitest.config.ts`, `apps/web/vitest.types.config.ts`, `apps/web/e2e/playwright.config.ts`, `apps/web/components.json`, `apps/web/src/styles/globals.css`, `apps/web/src/styles/tokens.css`, and `apps/web/.storybook/main.ts`.
- Shared TypeScript config: `packages/tsconfig/base.json`.
- Python package config: `workers/automation/pyproject.toml`.
- Python lockfile: `workers/automation/uv.lock`.
- Source registries: `workers/automation/src/jobhunter/config/sites.yaml`, `workers/automation/src/jobhunter/config/employers.yaml`.

**Environment configuration:**
- API bind and local data paths are resolved in `apps/api/src/config.ts`.
- Worker paths and defaults are resolved in `workers/automation/src/jobhunter/config.py`.
- `scripts/dev` sources a repo-root `.env` if present and sets defaults for `JOBHUNTER_DIR`, API host/port, web port, and Temporal DB.
- `workers/automation/src/jobhunter/config.py` loads `~/.jobhunter/.env` first, then a CWD `.env` fallback.
- `.env` contents are sensitive. Only `.env.example` is present in the scanned worktree root.

## Data And Artifact Runtime

**Local database:**
- SQLite application DB defaults to `~/.jobhunter/jobhunter.db`.
- Python SQLite uses WAL mode and `busy_timeout=10000` in `workers/automation/src/jobhunter/database.py`.
- TypeScript API SQLite access uses `busy_timeout=5000` in `apps/api/src/db.ts`.

**Local files:**
- Generated resumes, cover letters, logs, browser profiles, Gmail auth files, and apply worker state live under `~/.jobhunter`, as configured in `workers/automation/src/jobhunter/config.py`.
- Temporal dev history defaults to `.dev/temporal/temporal.db` through `scripts/dev`.

## Build, Test, And CI

**Root scripts:**
- `pnpm check` runs TypeScript package checks, API check, web check, and Python Ruff lint.
- `pnpm test` runs API tests, web build, and Python tests.
- `pnpm dev:setup` installs Node workspace dependencies and syncs the uv Python environment.

**TypeScript verification:**
- API: `pnpm api:check`, `pnpm api:test`, `pnpm qa:test`.
- Web: `pnpm web:check`, `pnpm web:build`, `pnpm web:test`, `pnpm web:test-d`, `pnpm web:e2e`, `pnpm web:storybook:test`.

**Python verification:**
- Tests: `uv --project workers/automation run --extra dev pytest -q`.
- Lint: `uv --project workers/automation run --extra dev ruff check .`.
- Build: `uv --project workers/automation run --extra dev python -m build workers/automation`.

**CI/CD:**
- TypeScript CI: `.github/workflows/typescript.yml` uses Node 20.19, pnpm install, `pnpm -r check`, API tests, web build, Storybook build/test, and Playwright Chromium install.
- Python CI: `.github/workflows/python.yml` tests Python 3.11, 3.12, and 3.13, installs LaTeX, runs Ruff, release scan, pytest, and package build.
- PyPI publish: `.github/workflows/publish.yml` builds `workers/automation` and publishes with PyPI trusted publishing on `v*` tags.

## Where To Add Stack Changes

- New API runtime dependencies: update `apps/api/package.json` and keep validation contracts in `packages/contracts/src`.
- New web runtime dependencies: update `apps/web/package.json`, then wire adapters/providers under `apps/web/src/shared` or bounded contexts under `apps/web/src/contexts`.
- New Python automation dependencies: update `workers/automation/pyproject.toml` and refresh `workers/automation/uv.lock`.
- New source registry defaults: update `workers/automation/src/jobhunter/config/sites.yaml` or `workers/automation/src/jobhunter/config/employers.yaml`.
- New env-driven behavior: document the variable in `README.md` and keep resolution in `apps/api/src/config.ts` or `workers/automation/src/jobhunter/config.py`.

---

*Stack analysis: 2026-06-08*
