# Architecture

**Analysis Date:** 2026-06-08

## System Overview

JobHunter is a local-first job search automation system. The current runtime is a pnpm TypeScript monorepo plus a uv-managed Python worker package. The user-facing app runs on loopback, the source of truth is local SQLite plus local artifact files, and workflow execution is delegated to a Python automation engine through JSON-RPC and Temporal.

```
React/Vite web app
`apps/web/src/main.tsx`
        |
        | HTTP + SSE through ports and `@jobhunter/api-client`
        v
Fastify local API
`apps/api/src/server.ts`
        |
        | reads projections, writes local state, dispatches JSON-RPC actions
        v
SQLite + local files under `~/.jobhunter`
`workers/automation/src/jobhunter/database.py`
        ^
        |
Python CLI/RPC/Temporal worker
`workers/automation/src/jobhunter/cli.py`
`workers/automation/src/jobhunter/infrastructure/rpc/server.py`
`workers/automation/src/jobhunter/infrastructure/temporal/worker.py`
        |
        | activities, use cases, adapters
        v
LLM providers, Playwright/Chrome, Gmail, source fetchers, PDF renderers
```

The architecture is split into eight bounded contexts shared across backend docs, Python domain packages, and frontend context folders: Discovery, Enrichment, Profile, Scoring, Materials, Apply, Pipeline, and Operations. Operations is the read-side context for projections and dashboard/debug surfaces.

## Component Responsibilities

| Component | Current responsibility | Key paths |
| --- | --- | --- |
| Web app | Browser UI, routing, view composition, frontend ports, TanStack Query cache, SSE-driven invalidation. | `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/routes/`, `apps/web/src/views/`, `apps/web/src/contexts/` |
| API app | Loopback HTTP API, read-model queries, simple local writes, event stream, JSON-RPC bridge to Python. | `apps/api/src/main.ts`, `apps/api/src/server.ts`, `apps/api/src/read-model.ts`, `apps/api/src/write-model.ts`, `apps/api/src/event-stream.ts`, `apps/api/src/local-actions.ts` |
| Shared TS packages | Zod DTOs, JSON-RPC schemas, pure TypeScript domain mirrors, typed HTTP client, shared tsconfig. | `packages/contracts/src/schemas.ts`, `packages/contracts/src/rpc.ts`, `packages/domain-types/src/`, `packages/api-client/src/client.ts`, `packages/tsconfig/` |
| Python CLI and worker | Typer CLI, local action execution, JSON-RPC server, Temporal worker, workflow entry points. | `workers/automation/src/jobhunter/cli.py`, `workers/automation/src/jobhunter/actions.py`, `workers/automation/src/jobhunter/infrastructure/rpc/`, `workers/automation/src/jobhunter/infrastructure/temporal/` |
| Python domain layer | Aggregates, value objects, use cases, domain services, event factories, ports. | `workers/automation/src/jobhunter/domain/` |
| Python infrastructure layer | SQLite repositories, event bus, projections, LLM/Gmail/Chrome/PDF/source adapters, runtime identity. | `workers/automation/src/jobhunter/infrastructure/` |
| Pipeline and apply orchestration | Stage runner, Temporal workflows, activities, apply workflow. | `workers/automation/src/jobhunter/pipeline/`, `workers/automation/src/jobhunter/apply/`, `workers/automation/src/jobhunter/discovery/activities.py`, `workers/automation/src/jobhunter/scoring/activities.py`, `workers/automation/src/jobhunter/materials/activities.py` |
| Persistence and artifacts | SQLite schema/migrations, stage state, projections, job events, generated resume/cover/PDF/apply artifacts. | `workers/automation/src/jobhunter/database.py`, `workers/automation/src/jobhunter/state.py`, `workers/automation/src/jobhunter/infrastructure/projections/` |

## Architectural Pattern

The current architecture combines:

1. **Local-first loopback app:** the browser talks to a local Fastify API. Mutating API routes are guarded by local-origin checks in `apps/api/src/server.ts` and `apps/api/src/local-origin.ts`.
2. **DDD and hexagonal worker:** Python domain packages under `workers/automation/src/jobhunter/domain/` define aggregates, use cases, services, events, and ports; adapter implementations live under `workers/automation/src/jobhunter/infrastructure/`.
3. **CQRS-style read side:** writes update canonical SQLite tables and `job_events`; read endpoints refresh and query projection tables through `apps/api/src/projections.ts`, `apps/api/src/read-model.ts`, and `workers/automation/src/jobhunter/infrastructure/projections/`.
4. **JSON-RPC boundary between TypeScript and Python:** the API uses `SubprocessJsonRpcAdapter` in `apps/api/src/json-rpc-adapter.ts` to run a long-lived `jobhunter rpc` process. Method schemas are defined in `packages/contracts/src/rpc.ts` and handled in `workers/automation/src/jobhunter/infrastructure/rpc/handlers.py`.
5. **Temporal-backed workflow execution:** stage actions started from the UI are translated to `WorkflowStartSpec` values and launched as Temporal workflows by `workers/automation/src/jobhunter/infrastructure/rpc/workflow_starter.py`. Workflow and activity registration is centralized in `workers/automation/src/jobhunter/infrastructure/temporal/registry.py`.
6. **Frontend context architecture:** `apps/web/src/contexts/` mirrors the eight bounded contexts. Views in `apps/web/src/views/` compose context components and Operations hooks instead of owning server state.
7. **Event-driven cache invalidation:** `apps/api/src/event-stream.ts` exposes `GET /v1/events/stream`; the web app consumes it through `apps/web/src/shared/adapters/local/SseEventStreamAdapter.ts`, `apps/web/src/contexts/operations/providers/EventStreamProvider.tsx`, and `apps/web/src/contexts/operations/invalidation-router.ts`.

## Layer Map

### Browser Presentation Layer

The browser entry point is `apps/web/src/main.tsx`. It constructs concrete local adapters for ports such as API, SSE, storage, session, clipboard, artifact opening, telemetry, and feature flags, then wraps the router in providers.

Routes are file-based TanStack Router modules under `apps/web/src/routes/`. Examples include `apps/web/src/routes/jobs.tsx`, `apps/web/src/routes/jobs.$jobId.tsx`, `apps/web/src/routes/artifacts.index.tsx`, `apps/web/src/routes/runs.tsx`, and `apps/web/src/routes/profile.import.upload.tsx`. Route search schemas live next to routes, for example `apps/web/src/routes/-jobs.search.ts`.

Views under `apps/web/src/views/` are page composers. Current view groups include `apps/web/src/views/dashboard/`, `apps/web/src/views/jobs/`, `apps/web/src/views/artifacts/`, `apps/web/src/views/apply-review/`, `apps/web/src/views/debug/`, `apps/web/src/views/discovery/`, `apps/web/src/views/pipelines/`, and `apps/web/src/views/runs/`.

Context folders under `apps/web/src/contexts/` own feature components, mutation hooks, query key factories, invalidation handlers, selectors, stores, and forms. Operations is special: it owns read-side query hooks such as `apps/web/src/contexts/operations/hooks/useJobsListQuery.ts` and the invalidation router.

### Local API Layer

The API entry point is `apps/api/src/main.ts`, which resolves config and starts the app built by `apps/api/src/server.ts`. The API exposes:

- health and dashboard endpoints in `apps/api/src/server.ts`.
- job list/detail/action endpoints backed by `apps/api/src/read-model.ts`, `apps/api/src/write-model.ts`, and `apps/api/src/local-actions.ts`.
- discovery, scoring, materials, apply, workflow-run, artifacts, profile, settings, credentials, and debug activity endpoints in `apps/api/src/server.ts`.
- the internal JSON-RPC endpoint `/v1/_internal/rpc` in `apps/api/src/server.ts`.
- the SSE endpoint `GET /v1/events/stream` in `apps/api/src/event-stream.ts`.

The API uses `better-sqlite3` helpers from `apps/api/src/db.ts`. Read endpoints call `refreshProjections` from `apps/api/src/projections.ts` before reading projection-backed responses from `apps/api/src/read-model.ts`.

Simple local mutations that can be completed in TypeScript are implemented in `apps/api/src/write-model.ts`; examples include mark applied, mark skipped, soft delete, restore, hide, reset stale scores, settings writes, and credential/profile writes. Stage/workflow actions that need Python logic go through `apps/api/src/local-actions.ts` and `apps/api/src/json-rpc-adapter.ts`.

### Shared TypeScript Contract Layer

`packages/contracts/src/schemas.ts` is the main HTTP DTO surface. It defines stage names, stage states, job filters, dashboard/read-model schemas, artifact schemas, apply-review schemas, request schemas, and settings/profile structures.

`packages/contracts/src/rpc.ts` defines the JSON-RPC envelope and the method-specific parameter/result schemas shared by the API and Python bridge. Current methods include `reset_stage`, `mark_applied`, `mark_skipped`, `cancel_stage`, `run_stage`, `rescore_job`, `rescore_jobs_not_on_current_scoring_policy`, `tailor_job`, `retailor_job`, `retailor_current_policy`, `apply`, `profile_import`, and `cancel_run`.

`packages/domain-types/src/pipeline.ts` mirrors pipeline stages and the discriminated `StageState` union in TypeScript. `packages/api-client/src/client.ts` wraps local HTTP endpoints in a typed client used by the web adapter.

### Python Domain Layer

The Python domain is organized by bounded context:

- `workers/automation/src/jobhunter/domain/discovery/`
- `workers/automation/src/jobhunter/domain/enrichment/`
- `workers/automation/src/jobhunter/domain/profile/`
- `workers/automation/src/jobhunter/domain/scoring/`
- `workers/automation/src/jobhunter/domain/materials/`
- `workers/automation/src/jobhunter/domain/apply/`
- `workers/automation/src/jobhunter/domain/pipeline/`
- `workers/automation/src/jobhunter/domain/operations/`

Shared domain event factories live in `workers/automation/src/jobhunter/domain/events/`. Port protocols live in `workers/automation/src/jobhunter/domain/ports/`. Common tenant and pipeline types live in `workers/automation/src/jobhunter/domain/tenant.py`, `workers/automation/src/jobhunter/domain/pipeline_types.py`, and `workers/automation/src/jobhunter/domain/pipeline/state_machine.py`.

The stage state machine has Python definitions in `workers/automation/src/jobhunter/domain/pipeline/state_machine.py` and TypeScript parity coverage in `packages/domain-types/test/state_machine_parity.test.ts`.

### Python Infrastructure and Runtime Layer

Infrastructure adapters are grouped by concern under `workers/automation/src/jobhunter/infrastructure/`:

- SQLite repositories: `infrastructure/discovery/sqlite_repository.py`, `infrastructure/enrichment/sqlite_repository.py`, `infrastructure/profile/sqlite_repository.py`, `infrastructure/scoring/sqlite_repository.py`, `infrastructure/materials/sqlite_repository.py`, `infrastructure/pipeline/sqlite_repository.py`, and `infrastructure/preparation/sqlite_repository.py`.
- Eventing: `infrastructure/events/in_process_bus.py` and `infrastructure/events/watermark.py`.
- Projections: `infrastructure/projections/projection_builder.py`, `infrastructure/projections/sqlite_projection_store.py`, and `infrastructure/projections/source_quality.py`.
- RPC: `infrastructure/rpc/server.py`, `infrastructure/rpc/handlers.py`, and `infrastructure/rpc/workflow_starter.py`.
- Temporal: `infrastructure/temporal/client.py`, `infrastructure/temporal/registry.py`, `infrastructure/temporal/worker.py`, `infrastructure/temporal/task_queues.py`, and `infrastructure/temporal/runtime_guard.py`.
- External adapters: `infrastructure/llm/llm_client.py`, `infrastructure/gmail/`, `infrastructure/apply/local_chrome.py`, `infrastructure/apply/claude_code_cli.py`, `infrastructure/enrichment/playwright_fetcher.py`, `infrastructure/materials/latex_pdf.py`, and `infrastructure/materials/playwright_html_pdf.py`.

The CLI entry point is `workers/automation/src/jobhunter/cli.py`, with package execution through `workers/automation/src/jobhunter/__main__.py`. Commands include local stage commands, `run`, `doctor`, `worker`, `rpc`, and Gmail auth flows.

### Persistence Layer

SQLite schema and migration setup are centralized in `workers/automation/src/jobhunter/database.py`. The local database lives under `~/.jobhunter` at runtime. The current schema includes the wide `jobs` table, per-context aggregate tables, `job_stage_states`, `job_events`, preparation work items, discovery runs, apply run events, operational metrics, and projection tables.

`workers/automation/src/jobhunter/state.py` is the public stage-state API used by stage runners. It states that `job_stage_states` is the canonical source of truth for per-job pipeline state. It also records durable events and artifacts.

Projection tables include `job_list_projections`, `dashboard_projections`, `job_detail_projections`, `artifact_list_projections`, `apply_run_projections`, `discovery_run_projections`, `source_quality_stats`, and `operational_attempt_metrics`. Python projection code lives in `workers/automation/src/jobhunter/infrastructure/projections/`; TypeScript refresh/read helpers live in `apps/api/src/projections.ts` and `apps/api/src/read-model.ts`.

## Primary Data Flows

### Web Read Path

1. A route loader or component uses an Operations query hook, for example `apps/web/src/routes/jobs.tsx` or `apps/web/src/contexts/operations/hooks/useJobsListQuery.ts`.
2. The hook uses the API port and typed client from `packages/api-client/src/client.ts`.
3. `apps/api/src/server.ts` handles the HTTP route and refreshes projections through `apps/api/src/projections.ts` where needed.
4. `apps/api/src/read-model.ts` reads projection tables and returns DTOs matching `packages/contracts/src/schemas.ts`.
5. TanStack Query caches the result using tenant-first query keys from `apps/web/src/contexts/operations/queryKeys.ts`.

### UI Write Path for Local Mutations

1. A context-owned mutation hook, for example `apps/web/src/contexts/pipeline/hooks/useMarkAppliedMutation.ts` or `apps/web/src/contexts/discovery/hooks/useDeleteJobMutation.ts`, calls the API through the web API port.
2. `apps/api/src/server.ts` validates and dispatches the route.
3. `apps/api/src/write-model.ts` updates local SQLite tables and records events.
4. The web mutation invalidates focused query keys immediately, and later SSE invalidation catches event-backed updates.

### UI Write Path for Python/Temporal Work

1. A context component or hook dispatches a stage, apply, rescore, tailor, or cancel action.
2. `apps/api/src/local-actions.ts` maps the action to a JSON-RPC method.
3. `apps/api/src/json-rpc-adapter.ts` starts or reuses a `uv --project workers/automation run jobhunter rpc` subprocess and sends newline-delimited JSON-RPC.
4. `workers/automation/src/jobhunter/infrastructure/rpc/server.py` validates and routes the request.
5. `workers/automation/src/jobhunter/infrastructure/rpc/handlers.py` handles synchronous commands or builds a `WorkflowStartSpec`.
6. `workers/automation/src/jobhunter/infrastructure/rpc/workflow_starter.py` starts a Temporal workflow.
7. `workers/automation/src/jobhunter/pipeline/workflow.py` or `workers/automation/src/jobhunter/apply/workflow.py` runs registered activities from `workers/automation/src/jobhunter/infrastructure/temporal/registry.py`.
8. Activities call stage logic in `workers/automation/src/jobhunter/pipeline/runner.py` and context modules such as `workers/automation/src/jobhunter/discovery/`, `workers/automation/src/jobhunter/scoring/`, `workers/automation/src/jobhunter/materials/`, and `workers/automation/src/jobhunter/apply/`.

### Pipeline Flow

The user-facing primary stages are `discover`, `score`, `tailor`, `cover`, and `apply`; the internal pipeline also includes `enrich`. The canonical stage order in Python is defined in `workers/automation/src/jobhunter/state.py` as `discover`, `enrich`, `score`, `tailor`, `cover`, `apply`.

`workers/automation/src/jobhunter/pipeline/workflow.py` executes a serial Temporal workflow for stage runs. It uses a child `ApplyWorkflow` for the apply stage. `workers/automation/src/jobhunter/pipeline/runner.py` implements the stage runner and contains the concrete `_run_discover`, `_run_enrich`, `_run_score`, `_run_tailor`, and `_run_cover` flows.

Discovery produces jobs and preparation work items. Enrichment verifies and snapshots postings. Scoring evaluates job fit. Tailoring creates resume artifacts and audit evidence. Cover creates cover letters. Apply runs browser/agent submission automation through the Apply context.

### Event and Realtime Flow

1. Python or TypeScript writes rows into `job_events`; stage helpers live in `workers/automation/src/jobhunter/state.py`.
2. The in-process Python bus in `workers/automation/src/jobhunter/infrastructure/events/in_process_bus.py` fans out in-memory events to subscribers such as projection builders.
3. The API SSE endpoint in `apps/api/src/event-stream.ts` tails `job_events` with tenant and resume filters.
4. The web SSE adapter in `apps/web/src/shared/adapters/local/SseEventStreamAdapter.ts` parses domain events from `packages/domain-types`.
5. `apps/web/src/contexts/operations/providers/EventStreamProvider.tsx` sends events to `apps/web/src/contexts/operations/invalidation-router.ts`.
6. Per-context handlers in `apps/web/src/contexts/*/handlers.ts` map events to focused query invalidations.

Current implementation note: `workers/automation/src/jobhunter/infrastructure/events/in_process_bus.py` documents that the bus is currently fan-out-only and that `state.py::record_job_event` still does the `job_events` insert inline before publishing the in-memory event.

## Key Abstractions

### Tenant

The current runtime is local-only and uses `LOCAL_TENANT`. Tenant-first query keys are still used in the web app, for example `apps/web/src/contexts/operations/queryKeys.ts`, so a future hosted tenant source can replace the local tenant without changing hook call shapes.

### Stage State

The stage state abstraction is shared across Python, TypeScript domain types, contracts, API responses, and UI badges. Python definitions live in `workers/automation/src/jobhunter/domain/pipeline_types.py` and `workers/automation/src/jobhunter/domain/pipeline/state_machine.py`. TypeScript definitions live in `packages/domain-types/src/pipeline.ts`. UI rendering lives in `apps/web/src/contexts/pipeline/components/StageBadge.tsx` and parity tests live in `apps/web/src/contexts/pipeline/components/every-stage-state-has-badge.test.tsx`.

### Domain Events

Python domain events use the immutable `DomainEvent` envelope in `workers/automation/src/jobhunter/domain/events/base.py`. Context-specific factories live in files such as `workers/automation/src/jobhunter/domain/events/discovery.py`, `workers/automation/src/jobhunter/domain/events/scoring.py`, `workers/automation/src/jobhunter/domain/events/materials.py`, and `workers/automation/src/jobhunter/domain/events/apply.py`.

The TypeScript event mirror lives in `packages/domain-types/src/`, and event-handler parity is checked by `apps/web/src/contexts/operations/every-event-has-handler.test.ts`.

### Repositories and Ports

Python domain code depends on protocols in `workers/automation/src/jobhunter/domain/ports/` and context repository interfaces such as `workers/automation/src/jobhunter/domain/pipeline/repository.py`. SQLite adapters implement those ports under `workers/automation/src/jobhunter/infrastructure/*/sqlite_repository.py`.

### Projections

Operations projections are modeled in Python at `workers/automation/src/jobhunter/domain/operations/projections.py`, built by `workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py`, stored by `workers/automation/src/jobhunter/infrastructure/projections/sqlite_projection_store.py`, refreshed from the API by `apps/api/src/projections.ts`, and exposed through `apps/api/src/read-model.ts`.

### Frontend Ports

The web app uses ports rather than direct globals for API, SSE, storage, session, clipboard, artifact opening, telemetry, and feature flags. Port definitions and local adapters live under `apps/web/src/shared/ports/` and `apps/web/src/shared/adapters/local/`. Concrete adapters are wired in `apps/web/src/main.tsx`.

### Query Keys and Invalidations

Read-side query keys are centralized under `apps/web/src/contexts/operations/` and re-exported by `apps/web/src/contexts/operations/queryKeys.ts`. Mutating contexts define their own query keys where needed, such as `apps/web/src/contexts/scoring/queryKeys.ts` and `apps/web/src/contexts/materials/queryKeys.ts`. SSE event fan-out is implemented by `apps/web/src/contexts/operations/invalidation-router.ts`.

### JSON-RPC

The JSON-RPC contract is intentionally explicit:

- TypeScript schemas: `packages/contracts/src/rpc.ts`.
- API subprocess adapter: `apps/api/src/json-rpc-adapter.ts`.
- Python message dataclasses: `workers/automation/src/jobhunter/domain/rpc/messages.py`.
- Python server: `workers/automation/src/jobhunter/infrastructure/rpc/server.py`.
- Python handlers: `workers/automation/src/jobhunter/infrastructure/rpc/handlers.py`.

## Entry Points

### Development Scripts

- Full local stack: `pnpm dev` from `package.json`.
- Detached stack lifecycle: `pnpm dev:start`, `pnpm dev:status`, `pnpm dev:logs`, and `pnpm dev:stop` from `package.json`.
- API development: `pnpm api:dev` from `package.json`.
- Web development: `pnpm web:dev` from `package.json`.
- Python commands: `uv --project workers/automation run jobhunter ...` through `workers/automation/pyproject.toml`.

### Runtime Entry Points

- API: `apps/api/src/main.ts` and `apps/api/src/server.ts`.
- Web: `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/router.ts`, and `apps/web/src/routes/__root.tsx`.
- Python CLI: `workers/automation/src/jobhunter/cli.py` and `workers/automation/src/jobhunter/__main__.py`.
- Python JSON-RPC: `workers/automation/src/jobhunter/infrastructure/rpc/server.py` and `workers/automation/src/jobhunter/infrastructure/rpc/handlers.py`.
- Temporal worker: `workers/automation/src/jobhunter/infrastructure/temporal/worker.py`.
- Temporal registry: `workers/automation/src/jobhunter/infrastructure/temporal/registry.py`.
- Job pipeline workflow: `workers/automation/src/jobhunter/pipeline/workflow.py`.
- Apply workflow: `workers/automation/src/jobhunter/apply/workflow.py`.

### Major API Surfaces

The Fastify app in `apps/api/src/server.ts` owns route registration. Current route groups include:

- `/v1/health`
- `/v1/dashboard/summary`
- `/v1/debug/activity`
- `/v1/discovery/*`
- `/v1/pipeline/actions/run-stage`
- `/v1/jobs/*`
- `/v1/scoring/*`
- `/v1/materials/*`
- `/v1/_internal/rpc`
- `/v1/workflow-runs/*`
- `/v1/artifacts/*`
- `/v1/profile/*`
- `/v1/settings`
- `/v1/credentials`

## Cross-Cutting Concerns

### Validation

HTTP request and response shapes are defined in `packages/contracts/src/schemas.ts`. JSON-RPC method schemas are defined in `packages/contracts/src/rpc.ts` and mirrored in Python by `workers/automation/src/jobhunter/domain/rpc/messages.py` plus handler validation in `workers/automation/src/jobhunter/infrastructure/rpc/server.py`.

### Safety and Local Boundaries

The product is local-first. The API is intended for loopback use, not as a public hosted API. Mutating HTTP routes use local-origin checks in `apps/api/src/server.ts` and `apps/api/src/local-origin.ts`. Local generated artifacts, profile data, credentials, application history, and SQLite databases are sensitive runtime data under `~/.jobhunter`, not repo data.

### Observability

Python observability and OpenTelemetry setup lives under `workers/automation/src/jobhunter/infrastructure/observability/`, including `otel.py`, `llm_spans.py`, `adapter_spans.py`, `enrichment_spans.py`, and `source_spans.py`. RPC spans are emitted by `workers/automation/src/jobhunter/infrastructure/rpc/server.py`. Pipeline and operational metrics are recorded through `workers/automation/src/jobhunter/operational_metrics.py` and projection read models.

The web app currently wires a local console telemetry adapter through `apps/web/src/main.tsx`.

### Error Handling

The API routes validate inputs, throw HTTP errors through Fastify, and use structured action results for local actions. JSON-RPC failures are returned as JSON-RPC error envelopes by `workers/automation/src/jobhunter/infrastructure/rpc/server.py`. Temporal activities use retry policies defined in `workers/automation/src/jobhunter/pipeline/workflow.py` and `workers/automation/src/jobhunter/apply/workflow.py`. The SSE provider drops unknown event payloads with telemetry and invalidates the full query cache after reconnect in `apps/web/src/contexts/operations/providers/EventStreamProvider.tsx`.

### Compatibility Seams

The implementation has modern DDD/projection structures while retaining compatibility with some older physical storage and stage modules. `workers/automation/src/jobhunter/database.py` still creates a wide `jobs` table, while `workers/automation/src/jobhunter/state.py` makes `job_stage_states` the canonical stage-state source. The stage runner in `workers/automation/src/jobhunter/pipeline/runner.py` still calls concrete stage modules under `workers/automation/src/jobhunter/discovery/`, `workers/automation/src/jobhunter/enrichment/`, `workers/automation/src/jobhunter/scoring/`, `workers/automation/src/jobhunter/materials/`, and `workers/automation/src/jobhunter/apply/`.

## Architecture Rules for Future GSD Planning

1. Add web server-state reads through Operations query hooks under `apps/web/src/contexts/operations/hooks/`; do not put direct `useQuery` or API calls in `apps/web/src/views/`.
2. Add web mutations in the owning bounded context under `apps/web/src/contexts/<context>/hooks/` and invalidate focused keys through the context's own mutation or `apps/web/src/contexts/operations/invalidation-router.ts`.
3. Add HTTP DTOs to `packages/contracts/src/schemas.ts` and typed client methods to `packages/api-client/src/client.ts` when changing API shape.
4. Add JSON-RPC methods by updating `packages/contracts/src/rpc.ts`, `apps/api/src/local-actions.ts`, `workers/automation/src/jobhunter/domain/rpc/messages.py`, and `workers/automation/src/jobhunter/infrastructure/rpc/handlers.py`.
5. Add Python business behavior in `workers/automation/src/jobhunter/domain/<context>/` first, then implement external effects in `workers/automation/src/jobhunter/infrastructure/<context>/`.
6. Add or change durable read models in both projection builders and API readers: `workers/automation/src/jobhunter/infrastructure/projections/`, `apps/api/src/projections.ts`, and `apps/api/src/read-model.ts`.
7. Keep stage-state changes synchronized across `workers/automation/src/jobhunter/domain/pipeline_types.py`, `workers/automation/src/jobhunter/domain/pipeline/state_machine.py`, `packages/domain-types/src/pipeline.ts`, and UI badge/parity tests.
8. Treat `job_events` plus projection state as the realtime/audit backbone. Do not mask missing evidence in the UI when the owning layer should compute or persist it.
