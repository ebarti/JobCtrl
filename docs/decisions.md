# Decisions

This file records architectural decisions. Keep entries short, dated, and
append-only unless a decision is superseded.

## 2026-05-01: Local-First Before SaaS Hardening

Status: accepted

Decision: validate JobHunter as a reliable local product before building hosted
multi-tenant infrastructure.

Rationale:

- the automation loop is the core product risk
- local SQLite and local artifacts already exist
- hosted auth, billing, tenancy, object storage, and deployment would distract
  from proving the workflow

Consequences:

- local data remains in `~/.jobhunter`
- SaaS hardening belongs in `docs/backlog.md`
- local safety and reliability tests gate near-term work

## 2026-05-01: TypeScript Product API, Python Workers

Status: accepted

Decision: use a TypeScript product API for frontend-facing local JSON contracts
and keep Python for automation workers.

Rationale:

- the frontend and product API benefit from shared TypeScript contracts
- Python already owns the automation implementation
- this avoids rewriting discovery, scoring, tailoring, PDF, and apply logic
  before the product is locally validated

Consequences:

- `apps/api` owns the local TypeScript API
- `packages/contracts` owns shared DTOs and schemas
- `packages/api-client` owns typed API transport
- `workers/automation/src/jobhunter` remains the automation engine

## 2026-05-02: Fastify For The Local API

Status: accepted

Decision: use Fastify for the local TypeScript API.

Rationale:

- small local service surface
- fast startup
- straightforward route registration
- compatible with schema-first request/response validation

Consequences:

- do not introduce SaaS-scale framework structure yet
- revisit the framework only if hosted product modules require it

## 2026-05-02: React With Vite For The Frontend

Status: accepted

Decision: use React with Vite for the local web UI.

Rationale:

- existing UI complexity has outgrown generated Python strings
- React gives a cleaner path for dashboard, jobs, artifacts, profile, and style
  editing flows
- Vite keeps local development fast

Consequences:

- Node.js `>=20.19.0` is required
- `apps/web` owns the React app
- `pnpm test` must include web typecheck and build

## 2026-05-02: Loopback API Binding By Default

Status: accepted

Decision: the local TypeScript API refuses non-loopback bind hosts unless the
user explicitly opts in.

Rationale:

- the API exposes local job, profile, and artifact metadata
- CORS does not protect against non-browser clients on the same network

Consequences:

- default host is `127.0.0.1`
- remote bind requires `JOBHUNTER_API_ALLOW_REMOTE_BIND=1`

## 2026-05-02: Stage State Is The Operational Source Of Truth

Status: accepted

Decision: `job_stage_states` should drive UI/API truth, retries, next
actions, failure state, and blocked state.

Rationale:

- wide nullable columns made stage progress hard to inspect and retry
- per-stage state makes failures actionable
- legacy fields remain useful for migration and fallback

Consequences:

- read paths materialize and hydrate stage rows
- retry operations target one stage
- tests must cover legacy-to-explicit state parity

## 2026-05-03: Copyable Commands Stay, Buttons Use Structured Actions

Status: accepted

Decision: keep copyable CLI commands in the UI, but make primary action buttons
call structured local action endpoints.

Rationale:

- copyable commands are useful for transparency and manual debugging
- button behavior should not depend on shell parsing
- long-running actions need explicit action status

Consequences:

- local UI actions use TypeScript API action endpoints
- Python action wrappers return structured JSON-safe results

## 2026-05-04: pnpm Workspace With Python Automation Worker

Status: accepted

Decision: organize the repository as a pnpm TypeScript workspace with runnable
apps under `apps/`, shared TypeScript packages under `packages/`, and the
Python automation worker under `workers/automation`.

Rationale:

- the product surface is now a TypeScript frontend plus local TypeScript API
- pnpm workspace filters make package ownership and commands explicit
- Python remains an independently packaged worker/CLI runtime managed by uv
- splitting `packages/contracts` from `packages/api-client` keeps schemas free
  of transport concerns

Consequences:

- `apps/api` and `apps/web` are the runnable TypeScript apps
- `packages/contracts` is schemas/DTOs/types only
- `packages/api-client` owns fetch/client behavior
- `workers/automation/pyproject.toml` owns Python packaging and CLI metadata
- `pnpm-lock.yaml` is the canonical JavaScript lockfile


## 2026-05-06: DDD + Hexagonal Architecture Adopted

Status: accepted

Decision: restructure the worker (and the read-side of the TS API) around the
eight bounded contexts defined in `docs/ddd-target.md` — Job Discovery,
Job Enrichment, Candidate Profile, Scoring, Materials Generation, Apply
Automation, Pipeline Orchestration, and Operations / Read-Side. Each context
has an aggregate root, value objects, domain events, driving use cases, and
driven ports; adapters live behind those ports.

Rationale:

- the dict-passing / SQLite-as-domain-model shape captured in the DDD briefing
  was preventing meaningful refactor and making the TS↔Python seam fragile
- explicit aggregates make invariants enforceable in one place per context
- ports + adapters give us a clean evolution path to the hosted architecture
  named in `docs/ddd-target.md` §5 / §9 (Postgres, S3, SQS, Browserbase,
  Temporal) without dual-writes

Consequences:

- `workers/automation/src/jobhunter/{domain,infrastructure}/<context>/`
  layout becomes the canonical worker shape
- pure types live in `packages/domain-types` (mirror of Python) — TS code
  derives state-machine logic from the same authority
- old "everything imports `database.py` directly" coupling is replaced by
  per-aggregate repositories
- migration was rip-and-replace (no strangler) per the single-user constraint;
  see `docs/plans/implemented/2026-05-06-ddd-migration.md`

## 2026-05-06: Per-Aggregate Repositories

Status: accepted

Decision: every aggregate root has a dedicated repository port (`JobRepository`,
`ProfileRepository`, `ScoreRepository`, `MaterialsRepository`,
`EnrichmentRepository`, `ApplyRunRepository`, `PipelineStateRepository`).
Local adapters are SQLite-backed; hosted adapters (Postgres) are named in
`docs/ddd-target.md` but not implemented yet.

Rationale:

- domain code now sees a typed, in-memory-collection-style interface; SQLite
  schema details live in the adapter
- swapping SQLite → Postgres becomes an adapter swap, not a domain rewrite
- per-aggregate tables (`job_scores`, `job_materials`, `job_enrichments`,
  `apply_runs`, `apply_run_events`, `job_stage_states`) decouple aggregates
  from the legacy wide `jobs` row

Consequences:

- the legacy `jobs.fit_score` / `jobs.tailored_resume_path` /
  `jobs.full_description` / `jobs.applied_at` columns are read-only fallback
  for un-backfilled rows; new writes target the per-aggregate tables
- read-side joins were canonicalised through projection tables in Phase 9
  (see next ADR)

## 2026-05-06: In-Process EventPublisher + Read-Model Projections

Status: accepted

Decision: integrate bounded contexts via domain events on a synchronous
in-process bus (`InProcessEventBus`); maintain five denormalised read-model
projections (`job_list_projections`, `dashboard_projections`,
`job_detail_projections`, `artifact_list_projections`,
`apply_run_projections`) that the TS read-model and dashboards query
directly. The hosted-future cutover is a SQS-FIFO transactional outbox per
`docs/ddd-target.md` §6.3.

Rationale:

- inter-context coupling through DB column reads (e.g. scoring reads
  `jobs.full_description` written by enrichment) is replaced by named events
  with documented payloads
- the read model used to LEFT-JOIN-with-COALESCE across six tables on every
  request; projections cache the join shape once per write so reads are
  flat SELECTs
- both the Python worker and the TS API maintain projections idempotently
  via the shared `event_watermarks.operations_projections` watermark, so
  either process catching up after restart produces the same projection state

Consequences:

- `record_job_event` may also publish through the bus; the
  `ProjectionBuilder` wildcard-subscribes on worker bootstrap
- `apps/api/src/projections.ts` is the TS-side mirror of the Python builder;
  read endpoints invoke it before SELECTing
- the legacy LEFT-JOIN-with-COALESCE helpers (`_LATEST_SCORE_JOIN`,
  `_LATEST_MATERIALS_JOIN`, `_LATEST_ENRICHMENT_JOIN`,
  `_LATEST_APPLY_RUN_JOIN`) are deleted from `read-model.ts`

## 2026-05-06: JSON-RPC 2.0 for the TS API ↔ Python Worker

Status: accepted

Decision: the integration protocol between the TS API process and the Python
worker is JSON-RPC 2.0 over a long-lived `jobhunter rpc` subprocess. The
`SubprocessJsonRpcAdapter` (`apps/api/src/json-rpc-adapter.ts`) speaks to
the `JsonRpcServer` (`workers/automation/src/jobhunter/infrastructure/rpc/`).
Method schemas are defined once in `packages/contracts/src/rpc.ts` and
mirrored in `workers/automation/src/jobhunter/domain/rpc/messages.py`.

Rationale:

- the previous pattern spawned a fresh `uv run jobhunter action ...`
  subprocess per request (~400 ms cold start), with stringly-typed action
  names parsed via Typer and stdout-scraped for results
- JSON-RPC gives us typed request/response envelopes, three dispatch modes
  (`sync`, `fire_and_forget`, `streaming`), and a single long-lived worker
  per API process
- the protocol matches what we'd ship to a hosted gRPC / HTTP transport
  later — Section 9 of `docs/ddd-target.md` names the swap

Consequences:

- `apps/api/src/local-actions.ts` no longer spawns subprocesses for actions;
  it routes through the JSON-RPC adapter
- the worker ships the `jobhunter rpc` Typer command (Phase 3 / S-11)
- TS-side JSON-RPC dispatcher is testable in isolation without spawning the
  Python worker (`apps/api/test/json-rpc-adapter.test.ts`)
