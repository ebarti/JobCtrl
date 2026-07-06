# Decisions (ADRs)

This is JobHunter's log of Architecture Decision Records (ADRs): short, dated,
append-only notes on why the codebase is shaped the way it is. Once written, an
entry stays verbatim — a reversed decision earns a new entry that supersedes the
old one, and later refinements are appended inline as dated amendments.

**Read this if** you are about to make an architectural change and want to know
what was already decided, when, and why — or you are reviewing a change against
prior decisions.

The index below groups the records by area; the records themselves follow in
chronological order. For the full inventory of every plan and spec that produced
these decisions — tracked plans and the untracked private planning corpus — see
the Historical Spec Ledger in `plans/README.md`.

## Index

**Product strategy & repository shape**

- [Local-First Before SaaS Hardening](#_2026-05-01-local-first-before-saas-hardening) · 2026-05-01
- [TypeScript Product API, Python Workers](#_2026-05-01-typescript-product-api-python-workers) · 2026-05-01
- [pnpm Workspace With Python Automation Worker](#_2026-05-04-pnpm-workspace-with-python-automation-worker) · 2026-05-04

**Local API & runtime**

- [Fastify For The Local API](#_2026-05-02-fastify-for-the-local-api) · 2026-05-02
- [Loopback API Binding By Default](#_2026-05-02-loopback-api-binding-by-default) · 2026-05-02
- [Stage State Is The Operational Source Of Truth](#_2026-05-02-stage-state-is-the-operational-source-of-truth) · 2026-05-02
- [Copyable Commands Stay, Buttons Use Structured Actions](#_2026-05-03-copyable-commands-stay-buttons-use-structured-actions) · 2026-05-03

**Backend domain model (DDD + hexagonal)**

- [DDD + Hexagonal Architecture Adopted](#_2026-05-06-ddd-hexagonal-architecture-adopted) · 2026-05-06
- [Per-Aggregate Repositories](#_2026-05-06-per-aggregate-repositories) · 2026-05-06
- [In-Process EventPublisher + Read-Model Projections](#_2026-05-06-in-process-eventpublisher-read-model-projections) · 2026-05-06
- [JSON-RPC 2.0 for the TS API ↔ Python Worker](#_2026-05-06-json-rpc-2-0-for-the-ts-api-↔-python-worker) · 2026-05-06

**Frontend architecture**

- [React With Vite For The Frontend](#_2026-05-02-react-with-vite-for-the-frontend) · 2026-05-02
- [TanStack Family Adopted For The Frontend](#_2026-05-06-tanstack-family-adopted-for-the-frontend) · 2026-05-06
- [Frontend Hexagonal Ports With Local + Hosted Adapters Named](#_2026-05-06-frontend-hexagonal-ports-with-local-hosted-adapters-named) · 2026-05-06
- [SSE Realtime Via `GET /v1/events/stream` + Invalidation Router](#_2026-05-06-sse-realtime-via-get-v1-events-stream-invalidation-router) · 2026-05-06
- [View-vs-Context Dichotomy + 1:1 Backend Bounded-Context Mirror](#_2026-05-06-view-vs-context-dichotomy-1-1-backend-bounded-context-mirror) · 2026-05-06

**Orchestration & workflow reliability (Temporal)**

- [Collapse `apply_runs` into the Temporal workflow run](#_2026-05-07-collapse-apply-runs-into-the-temporal-workflow-run) · 2026-05-07
- [Temporal Loop Closure — Finalize Activities + Describe Reconciler, Deterministic Workflow IDs](#_2026-07-03-temporal-loop-closure-—-finalize-activities-describe-reconciler-deterministic-workflow-ids) · 2026-07-03
- [DiscoverWorkflow And Default-Off Temporal Schedules](#_2026-07-03-discoverworkflow-and-default-off-temporal-schedules) · 2026-07-03
- [One Temporal Execution Path For Long-Running Work](#_2026-07-03-one-temporal-execution-path-for-long-running-work) · 2026-07-03
- [Heavy Sync RPC Handlers Become Workflows](#_2026-07-03-heavy-sync-rpc-handlers-become-workflows) · 2026-07-03
- [Classified Errors Drive Temporal Retry; Bounded Attempts](#_2026-07-03-classified-errors-drive-temporal-retry-bounded-attempts) · 2026-07-03
- [Per-Job JobPreparationWorkflow Replaces The Preparation Queue](#_2026-07-03-per-job-jobpreparationworkflow-replaces-the-preparation-queue) · 2026-07-03
- [Score-As-You-Discover Streaming In DiscoverWorkflow](#_2026-07-05-score-as-you-discover-streaming-in-discoverworkflow) · 2026-07-05

**Scoring, materials & tailoring**

- [Resume Tailoring Quality Is A Product System, Not Prompt Wording](#_2026-06-03-resume-tailoring-quality-is-a-product-system-not-prompt-wording) · 2026-06-03
- [Employer Analysis Via A 3-SDK Agent Ensemble](#_2026-06-09-employer-analysis-via-a-3-sdk-agent-ensemble) · 2026-06-09
- [Generated-Materials Audit Is Served From Canonical Provenance Rows](#_2026-06-09-generated-materials-audit-is-served-from-canonical-provenance-rows) · 2026-06-09
- [Requirement-Fit Ledger — Scores Resolve From Weighted Requirement Fit](#_2026-06-15-requirement-fit-ledger-—-scores-resolve-from-weighted-requirement-fit) · 2026-06-15
- [HTML/CSS Resume Rendering Replaces LaTeX](#_2026-06-24-html-css-resume-rendering-replaces-latex) · 2026-06-24
- [Requirement-Led Resume Tailoring](#_2026-06-30-requirement-led-resume-tailoring) · 2026-06-30

**Discovery & compensation**

- [Compensation Is Warning-Only Evidence From Reported Company-Role Observations](#_2026-06-20-compensation-is-warning-only-evidence-from-reported-company-role-observations) · 2026-06-20
- [Cross-Source Deduplication By Content Identity](#_2026-07-02-cross-source-deduplication-by-content-identity) · 2026-07-02

**Apply safety & outcomes**

- [Application-Outcome Feedback Loop With Bounded Gmail Ingestion](#_2026-06-01-application-outcome-feedback-loop-with-bounded-gmail-ingestion) · 2026-06-01
- [At-Most-Once Apply With Binding Approval Gate](#_2026-07-03-at-most-once-apply-with-binding-approval-gate) · 2026-07-03

**Data durability & spend**

- [SQLite Backup Command + Schema-Version Guard](#_2026-07-02-sqlite-backup-command-schema-version-guard) · 2026-07-02
- [Local LLM Spend Ceiling](#_2026-07-03-local-llm-spend-ceiling) · 2026-07-03

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
eight bounded contexts defined in `docs/architecture/domain-model/` — Job Discovery,
Job Enrichment, Candidate Profile, Scoring, Materials Generation, Apply
Automation, Pipeline Orchestration, and Operations / Read-Side. Each context
has an aggregate root, value objects, domain events, driving use cases, and
driven ports; adapters live behind those ports.

Rationale:

- the dict-passing / SQLite-as-domain-model shape captured in the DDD briefing
  was preventing meaningful refactor and making the TS↔Python seam fragile
- explicit aggregates make invariants enforceable in one place per context
- ports + adapters give us a clean evolution path to the hosted architecture
  named in `docs/architecture/domain-model/` §5 / §9 (Postgres, S3, SQS, Browserbase,
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
`docs/architecture/domain-model/` but not implemented yet.

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

Amended (2026-07-04): the bespoke `apply_runs` and `apply_run_events` tables
listed above were dropped (see the 2026-05-07 apply-run decision below); apply
lifecycle state now persists as domain events in `job_events` and is read back
through `apply_run_projections`. The other per-aggregate tables remain.

## 2026-05-06: In-Process EventPublisher + Read-Model Projections

Status: accepted

Decision: integrate bounded contexts via domain events on a synchronous
in-process bus (`InProcessEventBus`); maintain five denormalised read-model
projections (`job_list_projections`, `dashboard_projections`,
`job_detail_projections`, `artifact_list_projections`,
`apply_run_projections`) that the TS read-model and dashboards query
directly. The hosted-future cutover is a SQS-FIFO transactional outbox per
`docs/architecture/domain-model/` §6.3.

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

Amended (2026-07-04): the projection set has grown from five to **seven**. The
Temporal work added `workflow_run_projections` (Python-sole-writer; the unified
Workflow Runs list) and `source_quality_stats` (per-source discovery health).
The canonical list is `PROJECTION_TABLES` in
`infrastructure/projections/sqlite_projection_store.py`: `job_list_projections`,
`dashboard_projections`, `job_detail_projections`, `artifact_list_projections`,
`apply_run_projections`, `workflow_run_projections`, `source_quality_stats`.

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
  (`sync`, `workflow`, `streaming`), and a single long-lived worker
  per API process
- the protocol matches what we'd ship to a hosted gRPC / HTTP transport
  later — §9 of `docs/architecture/domain-model/cloud.md` names the swap

Consequences:

- `apps/api/src/local-actions.ts` no longer spawns subprocesses for actions;
  it routes through the JSON-RPC adapter
- the worker ships the `jobhunter rpc` Typer command (Phase 3 / S-11)
- TS-side JSON-RPC dispatcher is testable in isolation without spawning the
  Python worker (`apps/api/test/json-rpc-adapter.test.ts`)

2026-05-07 update (PR #36): the `fire_and_forget` dispatch mode is deleted
in favour of `workflow`. The JSON-RPC server now starts a Temporal workflow
through an injected `WorkflowStarter` and returns
`{runId, workflowId, firstExecutionRunId}`; cooperative cancellation is
handled by a new `cancel_run` method that signals the in-flight workflow.
The supported modes are now `(sync, workflow, streaming)`.

2026-07-03 update: `workflow` dispatch is Python-native. The TS API speaks
JSON-RPC to the Python worker; Python handlers build `WorkflowStartSpec`s and
start Temporal through the injected starter. TS does not enqueue Temporal work
directly in local mode. The remaining heavy methods (`profile_import`,
`refresh_compensation`, `apply`, batch/current-policy stage commands) return
workflow handles instead of doing blocking work inside the JSON-RPC request
thread.

## 2026-05-06: TanStack Family Adopted For The Frontend

Status: accepted

Decision: standardise the `apps/web` frontend on the TanStack family —
**TanStack Router** (file-based via `@tanstack/router-vite-plugin`),
**TanStack Query v5**, **TanStack Table v8**, and **TanStack Form** — paired
with shadcn/ui primitives over Radix and Tailwind CSS 4. The pre-migration
2,527-line `App.tsx` with `useState<View>` switching, `useEffect`-driven
fetches, manual `requestSeq` ref dedup, and `window.dispatchEvent`
cross-component coordination is gone.

Rationale:

- URL-first state is the right default: filters, sort, page index, drawer
  state, and selected job all need to survive refresh and be shareable. A
  router with typed search-param schemas (Zod-derived) makes this the path
  of least resistance; ad-hoc `useState` makes URL drift the path of least
  resistance.
- TanStack Query is the industry-standard server-state cache and is
  unmatched at hierarchical invalidation, optimistic updates, and stale /
  GC tuning. The eight backend `DomainEvent` invalidation handlers in
  `contexts/operations/invalidation-router.ts` build on its
  `invalidateQueries` / `setQueryData` primitives.
- TanStack Table v8 is headless: column models live with the consuming view,
  cell renderers compose context-owned components, and we get sort /
  pagination / column-resize without buying into chrome we cannot restyle.
- TanStack Form + Zod gives us the same "schema is the source of truth"
  discipline the backend has, with `safeParse` handling at every form
  boundary.
- Cohesion: all four primitives share idioms (router + query coordination
  via route loaders is an officially supported pattern), and the SSR /
  RSC evolution path is **TanStack Start** — the same router and query
  layer with a different bootstrap.

Alternatives considered:

- **Redux Toolkit Query + Wouter / React Router v6.** Workable but loses
  the URL-first ergonomics that file-based TanStack Router provides; RTKQ
  is heavier than Query for the same job; no native form story.
- **SWR + React Router.** SWR is fine for read caches but its mutation /
  invalidation model is thinner; no form story; no table.
- **Plain `useState` + custom fetch hooks.** What we had. Cannot scale past
  one user without becoming the next 2,527-line `App.tsx`.

Consequences:

- The frontend carries four TanStack runtime dependencies plus the Vite
  router-plugin (codegen for the route tree). The complexity is bounded
  and the pieces compose; the cohesion benefit outweighs the dependency
  count.
- TanStack Router's `routeTree.gen.ts` is generated and gitignored;
  developers must run `pnpm web:dev` once after pulling new routes for
  the codegen to settle.
- The hosted SSR / RSC evolution path (§9.1, §9.2 of
  `docs/architecture/frontend/`) is TanStack Start — same primitives, named
  not built.
- Cites: `docs/architecture/frontend/` §4.1, §4.3, §4.5, §4.6.

Amended (2026-07-04): three details above have drifted. (1) The router codegen
plugin is `@tanstack/router-plugin` — the `@tanstack/router-vite-plugin` package
was renamed; the Vite integration is imported from it. (2) `routeTree.gen.ts` is
**committed** to the repo (`apps/web/src/routeTree.gen.ts`), not gitignored. (3)
The invalidation router wires **seven** aggregate-context `DomainEvent` handlers
(`contexts/{discovery,enrichment,profile,scoring,materials,apply,pipeline}/handlers.ts`);
`operations/` hosts the router itself rather than a handler, so there are seven
handlers across the eight context folders, not eight.

## 2026-05-06: Frontend Hexagonal Ports With Local + Hosted Adapters Named

Status: accepted

Decision: the frontend ships its own hexagonal architecture. Components and
feature hooks depend only on **port interfaces**; concrete adapters bind in
`shared/providers/PortsProvider.tsx`. Eight ports are named, with the
local-mode adapter in `shared/adapters/local/` today and the hosted-mode
adapter named-not-built per the cloud-evolution path:

| Port | Local-mode adapter | Hosted-mode adapter (named) |
|---|---|---|
| `ApiClientPort` | `FetchApiClientAdapter` | Same adapter; JWT injected by hosted `AuthInterceptor`. |
| `EventStreamPort` | `SseEventStreamAdapter` | `WebSocketEventStreamAdapter`. |
| `StoragePort` | `LocalStorageAdapter` | `IndexedDbAdapter`. |
| `SessionPort` | `LocalSessionAdapter` (returns `LOCAL_TENANT`) | `JwtSessionAdapter` (Auth0 / Cognito). |
| `ClipboardPort` | `NavigatorClipboardAdapter` | Same adapter. |
| `OpenInOsPort` | `OpenArtifactAdapter` | Disabled in hosted mode; presigned-URL download instead. |
| `TelemetryPort` | `ConsoleTelemetryAdapter` | `OpenTelemetryWebAdapter` → OTLP. |
| `FeatureFlagPort` | `StaticFeatureFlagAdapter` | Backend-served, cached in Query. |

Rationale:

- Mirrors the backend's hexagonal architecture (`docs/architecture/domain-model/` §3,
  §5) so the same vocabulary applies on both sides of the wire.
- Cloud-evolution seams are in place from day one: every port that needs
  to swap when JobHunter goes hosted (auth, storage, telemetry, event
  transport) has its named adapter, and feature code is already coded
  against the interface. The migration is an adapter swap, not a
  feature-code rewrite. Per the no-strangler memo
  (`feedback_no_strangler.md`), each swap is rip-and-replace; the seam
  exists because a future swap will be a single PR.
- Port discipline kills the `window.dispatchEvent` /
  `navigator.clipboard.writeText` / `new EventSource(...)` calls that
  used to be sprinkled through feature code. Tests pass mocks to
  `<PortsProvider />` instead of installing per-test MSW handlers for
  every browser API.
- "Frontend driving ports" (use cases) are the per-context hooks
  themselves (`useApplyJobMutation`, etc.); React conventions are the
  de-facto driving-port representation, so we do not formalise a
  `UseCase` interface (§6.7).

Alternatives considered:

- **Direct `fetch` + `window.localStorage` + `new EventSource`.** What we
  had. Couples feature code to the host environment, makes hosted-mode
  swap a sweeping refactor, and forces every test to install browser-API
  mocks instead of passing a port adapter.

Consequences:

- One additional indirection layer through `usePorts()`. The cost is one
  hook call; the benefit is a hosted-mode swap that is bounded to the
  adapter file.
- The `OpenInOsPort` is the only port whose hosted-mode behaviour
  *cannot* be the same as local-mode (browsers cannot open local files);
  the hosted adapter returns `Unsupported` and the UI surfaces a
  presigned-URL download affordance instead.
- Cites: `docs/architecture/frontend/` §6, §9.

## 2026-05-06: SSE Realtime Via `GET /v1/events/stream` + Invalidation Router

Status: accepted

Decision: realtime updates flow over a Server-Sent Events stream
(`GET /v1/events/stream` on `apps/api`) into a pure-function
`InvalidationRouter` in `contexts/operations/invalidation-router.ts`. The
endpoint contract:

- `text/event-stream`; `Cache-Control: no-cache`; `X-Accel-Buffering: no`.
- Server tails `job_events` with the COALESCE on the *event row's*
  extracted tenant — `COALESCE(JSON_EXTRACT(payload_json, '$.tenantId'),
  'local') = :tenantId` — so legacy rows missing `$.tenantId` still match
  the local-mode filter without a write-side backfill. Emits each row as
  `id: <event_id>` + `event: <event_type>` + `data: <payload_json>`.
- Resume precedence: `Last-Event-ID` HTTP header (sent by the browser's
  native `EventSource` auto-reconnect) wins over `?since=<lastEventId>`
  query string (used only for IndexedDB warm-start hydration). Default
  is the current `MAX(event_id)` tail (no backfill).
- `retry: 5000` baseline reconnect; `: keepalive` comment every 15 s; an
  `event: heartbeat` carrying the current watermark every 30 s.
- Tenant scope is mandatory: in hosted mode, the server resolves
  `tenantId` from the JWT and rejects mismatched query-string values.

The frontend's `EventStreamProvider` opens a single `EventSource` per tab,
parses each frame against the `DomainEvent` Zod-discriminated union, and
dispatches to the invalidation router. The router maps
`DomainEvent → Set<QueryKey>` and either calls `invalidateQueries` (default)
or `setQueryData` (high-volume `ApplyRunEventRecorded` patches the in-memory
event list of the active apply-run query). On 30 s of "closed" status the
AppShell renders a "connection lost" banner; on reconnect the provider
fires a one-shot `invalidateQueries()` backstop.

Rationale:

- Unidirectional fits the use case: the frontend only consumes events. SSE
  is exactly this — no library, native `EventSource`, automatic reconnect
  with `Last-Event-ID`, plays nicely with HTTP/2 multiplexing, and Fastify
  streams `text/event-stream` natively with backpressure.
- CDN / proxy friendliness: plain HTTP, one long-lived response, debuggable
  in the network panel.
- Auth is the same path as REST (cookies or `Authorization` via a small
  polyfill).
- The router is testable in isolation: `handleEvent(event,
  mockQueryClient)` for each event type, asserting the exact set of
  `invalidateQueries` / `setQueryData` calls. Per `docs/architecture/frontend/`
  §10.2, this is "the most important unit test in the app" — the
  contract surface between the backend's events and the frontend's cache.
- The `Record<DomainEvent["eventType"], InvalidationHandler>` typing makes
  a missing handler a TypeScript compile error; the
  `every-event-has-handler.test.ts` parity test catches obvious empty
  stubs at runtime.

Alternatives considered:

- **WebSocket.** Bidirectional and adds framing overhead, harder to cache
  and edge-debug. Named-not-built as `WebSocketEventStreamAdapter` behind
  the same `EventStreamPort` if SSE proves limiting (e.g., reverse-proxy
  drops, or a future need to send messages over the same channel).
- **Polling.** Wasteful (event arrival is sparse but bursty), poor
  latency for long-running apply runs.

Consequences:

- The frontend gains a single point of cross-context invalidation. A new
  backend event is one PR touching the schema (`DomainEvent` discriminated
  union) plus one row in `invalidation-router.ts`.
- `EventSource`'s 6-connection-per-origin browser limit is not a concern
  for a single-user local app; it would matter under hosted multi-tenant
  scale, which is exactly when the WebSocket adapter's fitness function
  fires.
- Cites: `docs/architecture/frontend/` §7, §8.4.

Amended (2026-07-04): the `DomainEvent` type is a **plain TypeScript
discriminated union**, not a Zod schema. It lives in
`packages/domain-types/src/events/index.ts` (`DomainEventUnion`, 68 event types
in `DOMAIN_EVENT_TYPES`), mirrored by the Python registry — it is not in
`packages/contracts`. The SSE adapter validates each frame by set-membership on
the known event types plus `JSON.parse`
(`apps/web/src/shared/ports/lib/parseDomainEvent.ts`), not by Zod parsing. The
`Record<DomainEvent["eventType"], InvalidationHandler>` typing and the
`every-event-has-handler.test.ts` parity test still hold.

## 2026-05-06: View-vs-Context Dichotomy + 1:1 Backend Bounded-Context Mirror

Status: accepted

Decision: the frontend folder structure is **two siblings**:

- `apps/web/src/contexts/<name>/` — eight folders, **1:1 with the backend's
  bounded contexts** (Discovery, Enrichment, Profile, Scoring, Materials,
  Apply, Pipeline Orchestration, Operations). Each context owns its hooks,
  components, mutations, query-key factory, event handlers, selectors, and
  (for `operations/`) read queries + the SSE invalidation router. The
  ubiquitous language matches the backend verbatim — `JobId`, `Stage`,
  `MaterialsSet`, `ApplyRun`, `JobScored`, `ResumeApproved`, …
- `apps/web/src/views/<name>/` — three folders (`dashboard/`, `jobs/`,
  `artifacts/`) — **composers, not contexts.** A view file imports
  components and hooks from contexts and assembles them into a layout.
  Views own layout and view-local ephemeral UI (e.g., bulk-selection
  sets); they do **not** own query keys, mutations, or persistent state
  stores.

Dependency rules:

- Views depend on contexts; contexts never depend on views.
- A view never depends on another view (cross-view navigation goes
  through the URL).
- A context never imports another context's hooks or stores;
  cross-context coordination happens in (a) the view that composes them
  or (b) the invalidation router (§7.4) for cache fan-out.
- The view's only direct hook call into Operations is the read-side
  query (`useJobDetailQuery`); every other context the view shows
  appears as a component (`<ScoreBreakdown>`, `<StageTimeline>`,
  `<ApplyHistory>`, …) that encapsulates its own data dependency.

Rationale:

- "Tab" or "view" is a presentation concept; it is not a domain concept.
  When the backend says `JobScored` and the frontend says "score
  updated," the team carries two glossaries. When both say `JobScored`
  the team carries one.
- Eight context folders match the eight backend contexts so every UI
  feature has an unambiguous home. Even thin contexts (Discovery,
  Enrichment have minimal UI today) get a folder so the hook for
  `ImportJobUseCase` or a manual re-enrichment trigger lands without
  restructure when it ships.
- The composer / context split makes it impossible to accidentally
  introduce read-side coupling across contexts: only `operations/` owns
  reads, and only views import from multiple contexts.

Alternatives considered:

- **Feature folders by view (`features/dashboard/`,
  `features/jobs/`).** Conflates presentation surface with domain
  surface; "delete job" lives in jobs/ and dashboard/ both, or in some
  shared catch-all. Loses the 1:1 backend mirror.
- **Atomic CSS-style `components/`, `hooks/`, `pages/` flat folders.**
  The 2,527-line `App.tsx` is the limit case of this; it is exactly the
  shape we are leaving.

Consequences:

- One more folder layer than a flat `components/` layout; the cost is
  minimal and the discoverability benefit is large.
- Reviewers can verify in seconds whether a PR respects the dichotomy:
  any import of `views/*` from a `contexts/*` file is a violation; any
  import of one `contexts/*` from another (other than `operations/`) is
  a violation.
- Cites: `docs/architecture/frontend/` §3.10, §11.

Amended (2026-07-04): the view layer has grown from three folders to **eight**
under `apps/web/src/views/`: `apply-review`, `artifacts`, `dashboard`, `debug`,
`discovery`, `jobs`, `pipelines`, `runs`. The composer-not-context rule and the
eight-context-folder mirror above are unchanged.

## 2026-05-07: Collapse `apply_runs` into the Temporal workflow run

Status: accepted

Decision: drop the bespoke `apply_runs` + `apply_run_events` SQLite
tables. The Temporal workflow run is the canonical record of an apply
lifecycle; `apply_run_projections` (sourced from `job_events` by the
Python `ProjectionBuilder`) is the read-side. The TypeScript API
reads `apply_run_projections` directly and no longer materialises it.

Rationale:

- The bespoke `apply_runs` write path duplicated state already kept in
  `job_stage_states` (the canonical "is this job locked / succeeded /
  failed" row) and `job_events` (the durable event stream).
- A single source of truth for `apply_run_projections` removes the
  dual-write that the no-strangler memo forbids.
- The TS `apply_runs → apply_run_projections` projector and the Python
  `SqliteApplyRunRepository` are deleted, not feature-flagged.

Consequences:

- Existing local apply-run history is wiped on the next `init_db`
  (single-user codebase, no production users — accepted per
  `feedback_no_strangler.md`).
- The launcher's queue locks now live on
  `job_stage_states.apply.state == 'running'`; `acquire_job` /
  `mark_result` / `release_lock` / `reset_failed` write canonical
  stage state plus an `ApplyRunStarted` / `ApplicationSubmitted` /
  `ApplicationFailed` / `DryRunCompleted` event whose payload feeds
  the projection.
- The `ApplyRun` aggregate stays in-memory inside
  `SubmitApplicationUseCase` / `ApplySaga`; persistence happens via
  `record_job_event`.

Cites: `docs/plans/implemented/2026-05-07-temporal-and-worker-reliability-stack.md` PR 4.

Amended (2026-07-04): the decision above is accurate that the bespoke
`apply_runs` / `apply_run_events` tables were dropped, but the Python
`SqliteApplyRunRepository` class was **not** deleted — it is retained in
`apply/launcher.py` and now persists apply lifecycle facts through
`record_job_event` into the `job_events` event store (consistent with
"persistence happens via `record_job_event`" above). Only the bespoke tables and
the TS `apply_runs → apply_run_projections` projector were removed.

## 2026-06-01: Application-Outcome Feedback Loop With Bounded Gmail Ingestion

Status: accepted

Decision: JobHunter tracks what happens to a submitted application and closes the
loop with a bounded, Gmail-only email feedback path. A local review/outcome model
(review decisions, reviewed outcomes, linked email evidence, outcome suggestions)
lives in SQLite behind the existing Apply, Pipeline, Operations, and
Profile/Gmail boundaries — no new CRM context. A dedicated Gmail feedback module
(`infrastructure/gmail/feedback.py`, separate from the verification-only MCP
server) searches for messages that match a known application, scores confidence,
and fetches a full message body only after the message is linked to an
application; deterministic v1 classification maps bodies to confirmation,
recruiter reply, interview, assessment, rejection, offer, bounce, or unknown, and
produces outcome suggestions the user accepts or declines.

Rationale:

- outcome data is the signal that shows whether discovery, scoring, and tailoring
  are actually working; without it the pipeline is open-loop
- reusing the existing bounded contexts avoids a premature CRM abstraction for a
  single-user product
- a bounded feedback scanner (not a general mailbox reader) plus
  fetch-body-only-after-link keeps mailbox access proportionate to the feature

Consequences:

- raw Gmail bodies stay out of event payloads, telemetry, logs, and dashboard
  projections; only safe evidence identifiers are written into `job_events`
- email evidence is stored locally with body text and a body hash so duplicate
  Gmail message ids dedupe
- outcomes are suggestions until a user commits them; manual outcomes remain
  available without any mailbox scan
- the Apply Review queue (`views/apply-review/`) and the job drawer outcome
  timeline read these local models through Operations hooks

Cites: `docs/plans/implemented/2026-06-01-apply-review-outcome-feedback.md`;
PRs #115, #116, #117.

## 2026-06-03: Resume Tailoring Quality Is A Product System, Not Prompt Wording

Status: accepted

Decision: resume quality is controlled by typed evidence, deterministic checks,
and a tiered review gate rather than by prompt wording alone. Achievement evidence
becomes a typed profile value object with a claim mode (verified,
evidence-reframing, adjacent translation, draft-requiring-confirmation); only
verified and evidence-reframed claims may be auto-approved. Deterministic quality
checks (`domain/materials/quality.py`) enforce standard sections, required
evidence IDs, verified-metric sourcing, keyword coverage / anti-stuffing, and
seniority-appropriate scope before and after generation. High-fit jobs
(fit >= 8/10) additionally run a six-persona adversarial review
(`domain/materials/adversarial.py`) after the normal judge; any blocker keeps the
resume unapproved.

Rationale:

- "creativity" cannot be one boolean — the system needs claim modes so evidence
  reframing is auto-approvable while adjacent/draft claims require confirmation
- ATS readability, keyword stuffing, and seniority mismatch are partly
  deterministic and should be caught without spending an LLM judge call
- high-fit opportunities justify extra adversarial scrutiny; low-fit jobs should
  not pay that latency and cost
- quality needs golden failure fixtures (unsupported metric, AI voice, weak
  seniority, ATS-unfriendly, keyword stuffing, missing evidence, high-fit blocker)
  so regressions are caught locally without live LLM credentials

Consequences:

- profiles store typed achievement evidence and per-claim auto-approval policy;
  profiles without it stay valid
- deterministic quality failures feed the repair loop; warnings can trigger a
  retry but never silently approve unsupported claims
- the adversarial gate is skipped below the threshold and only runs after the
  judge passes
- a fixture-driven eval corpus under
  `workers/automation/tests/fixtures/tailoring_quality/` runs with fake ports; no
  fixture contains a real resume, profile, or application

Cites: `docs/plans/implemented/2026-06-03-resume-tailoring-quality.md`;
PRs #124, #125, #126, #127, #128.

## 2026-06-09: Employer Analysis Via A 3-SDK Agent Ensemble

Status: accepted

Decision: canonical employer/company analysis that feeds scoring and materials
is produced by a three-SDK agent ensemble behind the hexagonal
`AnalysisDraftPort` / `AnalysisSynthesizerPort` (`domain/ports/materials.py`).
`ClaudeAnalysisAdapter` (Claude Agent SDK), `CodexAnalysisAdapter` (Codex SDK),
and `AntigravityAnalysisAdapter` (Google Antigravity / Gemini SDK) draft in
parallel; `ClaudeAnalysisSynthesizer` merges them via `run_ensemble`
(`infrastructure/analysis/`). This is a separate LLM path from the
prefix-dispatched `LlmPort` used for scoring and tailoring generation.

Rationale:

- multiple independent drafts plus a synthesis pass reduce single-model
  hallucination and improve grounding on employer facts
- each adapter lazy-imports its SDK, so a missing SDK degrades to the available
  legs instead of failing the run
- an explicit port keeps the ensemble swappable and testable with fixtures

Consequences:

- the Codex leg isolates `CODEX_HOME` so ensemble runs do not pollute the user's
  own Codex chats (#149)
- ensemble legs, the synthesizer, and the voice pass are traced as Langfuse
  generation spans (#213)
- adding or removing a leg is an adapter change behind the port, not a change to
  the materials domain

Cites: PRs #145, #147 (3-way leg), #149, #205, #213.

## 2026-06-09: Generated-Materials Audit Is Served From Canonical Provenance Rows

Status: accepted

Decision: every audit claim shown for a generated resume is computed against the
shipped rendered text and served from canonical rows, never inferred from the job
description or derived on read. Accepted generations record per-bullet provenance
(`provenance_builder.py`) whose `generated_text` matches the rendered resume;
keyword coverage is computed by a rendered-text audit (`coverage_audit.py`) so a
keyword counts as covered only when a provenance-backed bullet demonstrates it;
coverage-bearing claims are bound to shipped lines by `claim_grounding.py` before
they count; and a formatting-tolerant grounding pass (normalize + snap-to-source)
tolerates whitespace and markup drift. The read model serves this audit data from
canonical rows only.

Rationale:

- the auditability discipline in `CLAUDE.md` requires every displayed claim to
  have an explicit source of truth; inferring coverage from job keywords or from
  LEFT-JOIN-derived guesses violates that
- provenance computed against the same payload that ships to the user keeps the
  audit faithful to the artifact, not to an intermediate draft
- serving audit from canonical rows (rip-and-replace of the derived read paths)
  removes the class of bug where the UI shows a value no source can defend

Consequences:

- failed re-tailor attempts never destroy the last accepted generation's artifact
  or provenance rows; failures remain audit history
- post-generation warnings are lifecycle-labeled (used-to-repair,
  accepted-residual, or produced-after-acceptance) so the audit says whether a
  warning influenced the shipped artifact
- Apply Review labels the coverage basis (`grounded_shipped_text_v1` vs
  `judge_claimed_legacy`) instead of hiding it
- adding an audit field means persisting it at the owning layer first, then
  projecting it — not computing it on read

Cites: PRs #142 (per-bullet provenance), #143 (voice pass + final audit against
rendered text), #144 (serve audit from canonical rows), #148 (formatting-tolerant
grounding). See `docs/architecture/tailoring.md`.

## 2026-06-15: Requirement-Fit Ledger — Scores Resolve From Weighted Requirement Fit

Status: accepted

Decision: a job's fit score is derived deterministically from a per-requirement
ledger, not from independent free-text signals. The Materials employer analysis
supplies grounded requirements (tier, weight, verbatim job-evidence span); the
Scoring context assesses candidate fit per requirement, resolves `FitScore` from
the weighted requirement contributions (`domain/scoring/requirement_fit.py`), and
persists a `RequirementFitReport` keyed by score version, employer-analysis
generation, profile snapshot, and scoring policy. Employer analysis is a hard
prerequisite: scoring requires it before it runs. The same requirement facts then
drive tailoring directives and Apply Review coverage, so one requirement matrix
explains score, tailoring action, and resume coverage across Jobs and Apply
Review.

Rationale:

- the previous implementation had three overlapping truths (broad scoring
  dimensions, canonical employer requirements, post-generation coverage) with no
  single canonical answer for why a score happened or what the tailor should
  optimize
- deriving the score from a weighted, evidence-referenced ledger makes each score
  explainable and makes high-weight missing requirements provably lower the score
- reusing the same requirement IDs end to end lets tailoring optimize exactly what
  scoring measured and lets Apply Review show coverage against the same
  requirements

Consequences:

- legacy `matched` / `missing` / `transferable` signals become derived summaries
  of the report rather than independent inputs
- old jobs without a report show `not_assessed` with a re-score path; the
  heuristic requirement matcher was retired once the report was available
  everywhere (no dual read model retained)
- unsupported missing requirements are prohibited claims for tailoring; hard
  blockers cap the score independently of the weighted average
- the report is projected onto job detail with Python/TypeScript projection parity

Cites: `docs/plans/implemented/2026-06-15-requirement-fit-ledger.md`;
PRs #162–#177, #189.

## 2026-06-20: Compensation Is Warning-Only Evidence From Reported Company-Role Observations

Status: accepted

Decision: JobHunter surfaces compensation as auditable, warning-only evidence and
never lets it change ranking, scoring, apply-readiness, or apply dispatch. A
deterministic source-access policy registry gates which observation sources are
usable; posted-salary facts are parsed from discovery text and stored canonically
without mutating `jobs.salary`; market estimates are computed only from reported
company-role observations (opt-in/licensed provider feeds and permitted public
community data), keyed by company/role/level with freshness, sample count, source
agreement, and company tier. Estimates are projected through the canonical read
model (`compensationSummary` / `compensationAudit` on job list and detail) with
EUR-normalized ranges, confidence intervals, and safe source attribution.

Rationale:

- compensation is decision-support, not an eligibility gate; letting weak salary
  data silently move ranking or apply-readiness would be unsafe
- estimating only from reported company-role observations (never title/location
  public aggregates) keeps estimates defensible, per the auditability discipline
- a source-access policy plus safe attribution keeps unlicensed scraping out and
  keeps provider payloads out of events, projections, and logs

Consequences:

- no automated third-party provider scrape or cache path and no US salary
  baseline; unavailable sources render as explicit unavailable-licensed seams
- weak evidence degrades to wider intervals or non-range states instead of
  overconfident precise ranges; fallback tiers are seniority-aware
- `CompensationFactsUpdated` events carry safe state markers only and route
  through Operations invalidation; event payloads never contain source text,
  credentials, or local paths
- a maintenance refresh (CLI `compensation-refresh`, plus job-scoped and all-jobs
  web/API actions) reparses and re-estimates existing jobs without rerunning
  discovery

Cites: PRs #180, #181, #182, #183, #184, #185, #187.

## 2026-06-24: HTML/CSS Resume Rendering Replaces LaTeX

Status: accepted

Decision: the default resume renderer is HTML/CSS printed to PDF through
Playwright (`html_pdf`); LaTeX (`latex_pdf`, `pdflatex`) is retained only as an
explicitly selected compatibility renderer via `JOBHUNTER_RESUME_RENDERER`.

Rationale:

- HTML/CSS + Playwright emits layout boxes that Apply Review consumes, so edits,
  comments, validation, and final PDF rendering stay tied to one generation
- the previous hand-rolled PDF writer truncated content; rendering through a real
  HTML renderer keeps the PDF faithful to the reviewed text (#210)
- TeX Live is large and awkward to ship; HTML/CSS avoids that dependency for the
  default path and any future container

Consequences:

- Playwright Chromium is a runtime requirement for resume PDF rendering
- LaTeX support remains for custom templates behind the explicit `latex_pdf`
  mode; `PDFLATEX_PATH` overrides the binary location
- tailoring fails closed if the resume PDF render fails, rather than shipping a
  degraded artifact

Cites: PRs #188, #210.

## 2026-06-30: Requirement-Led Resume Tailoring

Status: accepted

Decision: resume tailoring is driven by the job's extracted requirements. The
pipeline derives a requirement-fit view and grounds keyword coverage in the
shipped resume text, surfacing a requirement-fit report in job detail and Apply
Review. The change was designed and archived through the OpenSpec
propose/implement/archive workflow.

Rationale:

- tailoring against concrete requirements produces more relevant, less generic
  resumes than tailoring against the raw job description
- coverage claims are only meaningful when computed over the actual generated
  resume text, not inferred from job keywords (per the auditability discipline in
  `CLAUDE.md`)
- OpenSpec keeps the spec, tasks, and archive of a non-trivial materials change
  reviewable

Consequences:

- job detail exposes a requirement-fit report when the data exists
- keyword coverage is counted only when evidence-grounded in the shipped resume
  (#216, #224, #228)
- Apply Review labels coverage basis and revision semantics from the grounded
  audit (#229)

Cites: PRs #201 (proposal), #202 (implementation); follow-ups #216, #224, #228,
#229.

## 2026-07-02: SQLite Backup Command + Schema-Version Guard

Status: accepted

Decision: the local database ships a first-class backup command and a
schema-version guard. `jobhunter backup` (`cli.py`) writes a consistent copy via
`backup_database` (`database.py`); every connection runs `_ensure_schema_version`,
which stamps `PRAGMA user_version` to the code's `SCHEMA_VERSION` and refuses to
open a database whose schema is newer than the running code.

Rationale:

- the SQLite database is the single durable store of profile, jobs, events,
  projections, and review drafts; it needs a safe backup path
- opening a database written by newer code risks silent corruption, so the guard
  fails fast instead
- a stamped version gives future migrations a deterministic starting point

Consequences:

- users can snapshot the workspace before destructive or upgrade operations
- a newer-than-code database raises a clear error rather than being written
- an older or unstamped database is adopted by stamping the current version

Cites: PR #206.

## 2026-07-02: Cross-Source Deduplication By Content Identity

Status: accepted

Decision: discovered postings are deduplicated across all sources by content
identity, not only within jobspy or by URL. `domain/job_content_identity.py`
defines the content-match basis; the discovery repository resolves an incoming
posting to an existing `Job` after native-id and URL misses
(`infrastructure/discovery/sqlite_repository.py`).

Rationale:

- the same role is frequently posted on multiple boards with different URLs;
  URL-only dedup created duplicate jobs
- a genuine-employer-identity check avoids collapsing distinct roles that merely
  share superficial text
- dedup at discovery keeps duplicates out of enrichment, scoring, and materials

Consequences:

- a posting can resolve to an existing job by content identity and record how it
  matched (`ContentMatchBasis`)
- the discovery port surfaces the match basis for auditability
- cross-board duplicates are collapsed before downstream stages run

Cites: PR #212 (building on earlier dedup work #108).

## 2026-07-03: At-Most-Once Apply With Binding Approval Gate

Status: accepted

Decision: live apply submission is at-most-once across Temporal retries and
worker crashes. Single-job apply uses a deterministic
`apply-{tenantId}-{jobKey}` workflow id, live apply activity retry is capped at
one attempt, and the domain records `ApplySubmitIntended` immediately before an
autonomous agent may submit. The default settings require a committed
`approve_submit` Apply Review decision before a live claim can proceed; the
approval check runs in the launcher's `BEGIN IMMEDIATE` claim transaction. Dry
run remains available without approval but is physically guarded at the browser
layer by CDP request/form interception.

Rationale:

- retrying after the agent reached a submit button can create duplicate employer
  submissions
- approval is only binding if it is enforced by the backend claim, not only by
  UI affordances
- prompt-only dry-run instructions are insufficient protection against hostile
  or surprising pages

Consequences:

- ambiguous live runs after submit intent park in `needs_verification` for
  human resolution instead of being auto-requeued
- live runs without approval stay pending and record an awaiting-approval event
- every run persists raw agent output, and successful live results persist
  confirmation evidence with conservative verification confidence

## 2026-07-03: Temporal Loop Closure — Finalize Activities + Describe Reconciler, Deterministic Workflow IDs

Status: accepted

Decision: Temporal workflow execution becomes visible and self-terminalizing
without a TypeScript Temporal SDK and without trigger-coupled reapers.

- **`Workflow*` event family (6 types)** — `WorkflowStarted`,
  `WorkflowCompleted`, `WorkflowFailed`, `WorkflowCanceled`, `WorkflowTimedOut`,
  `WorkflowTerminated` — landed in lockstep across the Python and TS event
  registries and the web invalidation router (61 → 67 event types). They carry
  `workflowId`, `workflowType`, an input summary, and a terminal status within
  the existing 12-state `WORKFLOW_RUN_STATUSES`.
- **Loop closure via finalize activities.** Every workflow emits a
  `WorkflowStarted` marker at the top and records exactly one terminal event
  through a finalize activity (`infrastructure/temporal/finalize.py`) that
  reuses `record_job_event` + a projection refresh. Normal completion →
  `WorkflowCompleted`; a stage/exception failure → `WorkflowFailed`.
- **Describe-based reconciler** in the worker heartbeat loop (15s) backstops
  finalize: it `describe`s each open `workflow_run_projections` row and
  terminalizes CLOSED executions (mapped to the matching terminal event) or
  NOT_FOUND executions (dev-server history loss → `WorkflowTerminated`), leaving
  RUNNING rows alone. Cancellation and worker-crash/timeout terminalization
  flow through the reconciler because Temporal cancels newly-scheduled
  activities during workflow cancellation, so finalize cannot record from the
  cancel path.
- **`workflow_run_projections`** is a new Python-sole-writer projection (folded
  from the `Workflow*` events under the shared `operations_projections`
  watermark, mirrored read-only in `apps/api/src/projections.ts`). It is the
  unified list source for the Workflow Runs view across all workflow types;
  `apply_run_projections` remains the apply-specific detail projection and
  enriches apply rows via a LEFT JOIN.
- **Deterministic workflow IDs + overlap policy.** `WorkflowStartSpec` carries
  `id_conflict_policy` / `id_reuse_policy`; the default starter passes
  `USE_EXISTING` + `ALLOW_DUPLICATE`, so a double-start of a deterministic id
  returns the running handle instead of a duplicate execution. `apply_action`
  derives a stable `apply-{jobKey}` id for single-job applies; the pipeline
  orchestrator keeps `run-{uuid}`. Batch/continuous apply ids are deferred to
  P2.
- **JSON-RPC hang closure.** The Python `JsonRpcServer` dispatches each request
  on a bounded thread pool (stdout writes serialized under a lock), so a
  slow/hung handler no longer head-of-line-blocks cancel; the TS adapter has a
  per-request timeout; the api-client wraps every fetch in an AbortController
  timeout. Out-of-order responses correlate by JSON-RPC `id`.

Rationale: the 2026-07-02 resilience audit found Temporal wired but sidelined —
results unread, failures invisible, recovery trigger-coupled. Finalize plus a
describe reconciler make terminal state durable and self-healing while keeping
the Python-native JSON-RPC boundary (no `@temporalio/*` in TS).

Consequences:

- Cancelling a pipeline/apply workflow currently surfaces as a visible failed
  terminal (the workflows catch the cancellation `ActivityError` as a stage
  failure); true `WorkflowCanceled` status for those workflows lands with P1's
  cancellation work (CC6). The reconciler already maps genuinely-CANCELED
  executions to `WorkflowCanceled`.
- Historical apply runs that predate the `Workflow*` events do not appear in
  the unified runs list until they re-run (accepted cutover loss per
  `feedback_no_strangler.md`); the dashboard's recent-apply panel is unchanged.

Cites: `docs/plans/implemented/2026-07-03-temporal-native-rearchitecture.md` (P0).

## 2026-07-03: DiscoverWorkflow And Default-Off Temporal Schedules

Status: accepted

Decision: discovery is a tenant-scoped `DiscoverWorkflow` with deterministic id
`discover-{tenantId}`. The workflow plans source families, executes one
source-family activity per planned family with real `DiscoveryRunProgress`
heartbeats, drains enrichment in a separate activity, and then starts
`JobPreparationWorkflow` children. The legacy discover/enrich reaper is deleted;
worker death is recovered by Temporal retry/resumption and workflow finalization.
Local Temporal Schedules are supported but disabled by default. Worker startup
reconciles `jobhunter-discovery-local`: disabled settings delete the schedule;
enabled settings create or update a cron schedule with
`ScheduleOverlapPolicy.SKIP`.

Rationale:

- source-family activities give Temporal a real heartbeat and retry boundary
  without retrying the entire discovery batch
- disabled-by-default schedules avoid surprising background crawling on fresh
  installs
- concrete failed source ids are required for source-quality quarantine and
  circuit-breaker attribution

Consequences:

- `run_stage discover` returns the existing `discover-{tenantId}` workflow
  handle when a discovery run is already live
- source failures are attributed to their concrete `source_id`; repeated
  failures quarantine only the failing source
- the removed `discovery_run_projections` write-only table no longer owns any
  read-model behavior; source health is projected through `source_quality_stats`

## 2026-07-03: One Temporal Execution Path For Long-Running Work

Status: accepted

Decision: every long-running entry point starts a Temporal workflow. The CLI,
JSON-RPC handlers, local actions, and API-facing dispatch paths share workflow
spec builders; the in-process pipeline runner and compatibility re-exports are
deleted.

Rationale:

- local workflow recovery, retries, cancellation, and visibility should be the
  same whether a user starts work from the UI, CLI, or JSON-RPC
- fallback execution hid failures from the runs UI and could not survive worker
  interruption
- deterministic workflow IDs preserve idempotency where duplicate dispatch is
  unsafe

Consequences:

- `jobhunter run` and per-stage commands require a reachable Temporal server
  plus a running JobHunter worker
- workflow start failures are reported immediately with no in-process fallback
- `_run_stage_observed` remains the stage event/metric/span boundary inside
  activities

## 2026-07-03: Local LLM Spend Ceiling

Status: accepted

Decision: record local LLM token usage into `llm_spend` and enforce a daily
budget before workflows that can spend tokens begin their heavy activity.
`dailyBudgetUsd` defaults to `25`; `0` means unlimited.

Rationale:

- local automation can issue many LLM calls after a broad discovery run
- the budget check needs to happen in the durable workflow path, not only in UI
  controls
- spend visibility belongs in the same operations/health surface as worker
  health because it is an operational readiness signal

Consequences:

- usage is captured at existing LLM span / SDK usage points without
  double-counting
- over-budget workflows fail fast with non-retryable `budget_exceeded`
- Preferences and health expose the configured budget and today's estimated
  spend

## 2026-07-03: Heavy Sync RPC Handlers Become Workflows

Status: accepted

Decision: `profile_import` and `refresh_compensation` are Temporal workflows.
Profile import wraps the existing implementation in an activity; compensation
refresh has a shared core under `infrastructure/compensation/` and one workflow
activity.

Rationale:

- both operations can block the long-lived JSON-RPC worker thread
- workflow conversion gives the runs UI, finalize events, cancellation, and
  reconciler the same visibility as stage/apply work
- the TS API already handles the workflow-run result shape

Consequences:

- callers receive `{runId, workflowId, firstExecutionRunId}` and observe
  completion through the workflow-runs read model
- the old synchronous handler body is not retained as a compatibility wrapper
- tests cover the extracted compensation core separately from RPC dispatch

## 2026-07-03: Classified Errors Drive Temporal Retry; Bounded Attempts

Status: accepted

Decision: worker activities raise classified domain errors that map to Temporal
retry behaviour, and activities are interruptible. Retryable failures retry
within the activity's policy; non-retryable failures (e.g. `budget_exceeded`
from `BudgetExceededError`, `domain/errors.py`) fail fast without retry. LLM
retries and per-stage score attempts are explicitly bounded.

Rationale:

- retrying a non-retryable failure (budget exceeded, permanent validation error)
  wastes spend and hides the real cause
- unbounded LLM retries and score attempts can run up cost after a broad
  discovery run
- interruptible activities let cancellation and timeouts take effect promptly

Consequences:

- Temporal retry policy is driven by error classification, not a blanket policy
- score attempts are capped and LLM retries are bounded (P1a)
- non-retryable errors surface as terminal workflow failures in the runs view

Cites: PRs #231 (P1a: bound LLM retries, cap score attempts), #235 (P1b:
classified errors into Temporal retry, interruptible activities).

## 2026-07-03: Per-Job JobPreparationWorkflow Replaces The Preparation Queue

Status: accepted

Decision: per-job preparation (enrichment → scoring → tailoring eligibility →
material generation or suppression) is a per-job Temporal workflow,
`JobPreparationWorkflow` with deterministic id `prep-{jobKey}`, exposed behind a
preparation port (`domain/ports/preparation.py`). It replaces the earlier
in-process preparation queue. `DiscoverWorkflow` starts one preparation child per
discovered job.

Rationale:

- a per-job workflow gives each job its own retry, timeout, heartbeat, and
  finalize boundary instead of one coarse queue
- deterministic ids make double-start idempotent (a live job returns the running
  handle)
- preparation lifecycle becomes visible in the runs read model like other
  workflows

Consequences:

- preparation emits `PreparationWorkItem*` lifecycle events
- per-job stage truth remains in `JobPipelineState`; preparation orchestrates, it
  does not own stage-state invariants
- the in-process preparation queue and its reaper are removed

Cites: PR #237 (P3).

## 2026-07-05: Score-As-You-Discover Streaming In DiscoverWorkflow

Status: accepted

Decision: `DiscoverWorkflow` scores jobs as it discovers them. After **each
source family completes** it runs enrichment + preparation fan-out for that
family's jobs immediately, instead of once after every family. Three sub-choices
resolve the streaming plan's open decisions:

1. **Progress model.** The denominator stays fixed at plan time
   (`progress_total = len(families) + 2`) and the counter is monotonic: family
   source activities advance it, and a terminal reconcile enrichment +
   preparation finalize it to 100%. The per-family streaming passes are
   **progress-silent** (`progress_total=0`), so the Runs bar never oscillates or
   shrinks. Incremental scores reach the UI through the independent
   `JobScored` → projections → SSE path, not the progress bar. No new
   `discovery_runs` columns, so both projection builders stay in parity.
2. **Phase-1 shape.** Per-family streaming passes **plus** a terminal reconcile
   enrichment + fan-out (plan option (b)). The terminal pass remains
   authoritative for the tolerated-partial-failure folding (succeed if ≥1 family
   completed; fail as `discovery_source_failed` only if all failed) and for
   progress finalization; the streaming passes are additive and best-effort (any
   non-cancellation failure is left for the terminal pass to sweep up, deduped by
   the deterministic id). This keeps the existing folding + progress semantics
   unchanged and low-risk.
3. **Race-free repeated fan-out.** The per-job workflow id
   `prep-{idempotency_key}` + `WorkflowIDConflictPolicy.USE_EXISTING` make N
   fan-out invocations start exactly one workflow per job. Because the
   idempotency key includes `kind`, a fresh job that crosses
   `pending_score` → `pending_tailor` mid-tailor would otherwise be re-derived as
   a second `TAILOR_RESUME` workflow racing its own in-flight `SCORE_JOB`
   workflow (Phase 2's per-job handoff scores jobs the instant they are
   enriched, so this is reachable well before end-of-run). To prevent that
   double-tailor, the fan-out gains an `include_pending_tailor` flag and a
   one-time straggler sweep (`include_pending_tailor=True`) runs **before the
   family loop** — the only moment `pending_tailor` holds only pre-existing
   scored-but-not-tailored work and cannot contain a fresh job already owned by
   a this-run `SCORE_JOB` workflow. Every family + terminal fan-out is
   score-only. (Running the sweep up front, rather than on the first completed
   family, is also what keeps it correct when families run concurrently in
   Phase 3.)
4. **Phase 2 handoff mechanism (Temporal-native, event-driven).** A job's
   preparation starts the moment it is individually enriched, not after its whole
   family. The mechanism is event-driven from **inside** the enrichment activity
   (an `on_job_enriched` callback threaded to `enrichment/detail.py`, fired per
   job after its commit), chosen over ad-hoc polling. Because the start is a side
   effect inside the activity, `DiscoverWorkflow`'s command history is unchanged
   (determinism/replay safe). The per-job start uses the same deterministic
   `SCORE_JOB` id as the fan-out, so the handoff and the reconciling fan-outs
   converge on exactly one execution per job (`USE_EXISTING`); a re-enrichment
   that changes `source_event_id` legitimately forks a new workflow. Per-job
   starts are serialized by a lock (site enrichment can run in parallel threads)
   and are best-effort (a start failure is logged and left for the fan-out
   backstop, never mistaken for an enrichment failure).

Rationale:

- Time To First Score drops materially: an early family's jobs are scored while
  later families are still crawling, instead of after the whole run.
- Every prior invariant holds — fan-out idempotence (I1), tolerated
  partial-source failure (I2), determinism/replay (I3), the daily spend ceiling
  and per-job preflight (I4), the `min_score` gate (I5), cancellation/heartbeats
  (I6), and honest monotonic progress (I7).
- Reusing the existing terminal pass for folding + progress keeps the blast
  radius small and the read-model parity intact.

Consequences:

- `DiscoveryPreparationFanoutInput` / `start_discovery_preparation_workflows` /
  `derive_preparation_targets` gain an `include_pending_tailor` flag (default
  `True` preserves the pre-streaming full derive).
- Fan-out and enrichment activities now run per completed family plus once at the
  terminal reconcile; repeated invocation is safe by construction (I1).
- Phase 2 adds a `per_job_handoff` flag + prep params on the enrichment activity,
  a `start_job_preparation_workflow` single-job starter, and an opaque
  `on_job_enriched` callback threaded from the activity to `enrichment/detail.py`
  (`run_discovery_enrichment_stage` → `_run_discovery_enrichment_until_idle` →
  `_run_enrich` → `run_enrichment` → `_run_detail_scraper` → `scrape_site_batch`).
- Parallel source families remain **out of scope** here — that is R9 Phase 3,
  gated behind an explicit browser-concurrency bound.

Cites: R9 streaming-pipeline-latency plan
(`docs/plans/2026-07-05-streaming-pipeline-latency-plan.md`), Phase 1.
