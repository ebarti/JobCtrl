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
  (`sync`, `workflow`, `streaming`), and a single long-lived worker
  per API process
- the protocol matches what we'd ship to a hosted gRPC / HTTP transport
  later — Section 9 of `docs/ddd-target.md` names the swap

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
  `docs/frontend-target.md`) is TanStack Start — same primitives, named
  not built.
- Cites: `docs/frontend-target.md` §4.1, §4.3, §4.5, §4.6.

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

- Mirrors the backend's hexagonal architecture (`docs/ddd-target.md` §3,
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
- Cites: `docs/frontend-target.md` §6, §9.

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
  `invalidateQueries` / `setQueryData` calls. Per `docs/frontend-target.md`
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
- Cites: `docs/frontend-target.md` §7, §8.4.

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
- Cites: `docs/frontend-target.md` §3.10, §11.
