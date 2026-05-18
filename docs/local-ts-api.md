# Local TypeScript API

The local TypeScript API is the runnable backend app under `apps/api`.

It owns product-facing JSON endpoints, reads the local SQLite database, and
invokes Python automation through the JSON-RPC 2.0 protocol over a long-lived
`jobhunter rpc` subprocess. It is intentionally local-first and binds to
`127.0.0.1` by default.

`GET /v1/profile` and `PATCH /v1/profile` use the normalized Candidate
Profile tables in `jobhunter.db` as the source of truth. When the profile
tables are empty, the API can seed them once from legacy `profile.json`,
`resume_style.json`, and `resume_template.tex`; subsequent writes update only
SQLite and reconstruct the existing response object shape for frontend/client
compatibility.

Read-model endpoints (`/v1/dashboard/summary`, `/v1/jobs`, `/v1/jobs/:key`,
`/v1/artifacts`, `/v1/workflow-runs`) read from the local `*_projections` tables
maintained by `apps/api/src/projections.ts` (TS-side mirror) and the Python
`ProjectionBuilder` (`workers/automation/src/jobhunter/infrastructure/projections/`).
Both processes refresh projections idempotently via the shared
`event_watermarks.operations_projections` watermark.

`/v1/jobs` and `/v1/jobs/:key` expose the latest persisted scoring evidence
from `job_scores` as additive read-model fields: `scoreBreakdown`,
`scoreKeywords`, `scoreVersion`, and `scoredAt`. `scoreReasoning` remains on
the wire as a compatibility summary during the scoring evidence migration.
The jobs list `deleted` filter accepts `active`, `deleted`, `hidden`, or `all`.
Deleted jobs are temporary removals: discovery clears the delete tombstone when
the same posting is observed again. Hidden jobs use a separate
`jobhunter_hidden_jobs` tombstone and remain suppressed from active/deleted
lists, dashboard totals, artifacts, workflow runs, and activity until an unhide
mutation clears that hidden tombstone. The API exposes bulk hide/unhide routes
at `POST /v1/jobs/bulk-hide` and `POST /v1/jobs/bulk-unhide`, plus single-job
`POST /v1/jobs/:key/hide` and `POST /v1/jobs/:key/unhide`. Permanent delete is
available at `POST /v1/jobs/bulk-delete-permanent` and
`DELETE /v1/jobs/:key/permanent`; it removes the job row plus job-scoped state,
projection rows, and delete/hide tombstones. It does not write a new suppression
record, so rediscovery can add the same posting again later.

`/v1/dashboard/summary` includes `sourceHealth[]`, sourced from
`source_quality_stats`. The projection is rebuilt from discovery run,
source-observation, duplicate, content snapshot, enrichment, apply-URL, and
active-state events and user discovery feedback. It is the read-side signal the
web dashboard uses for source health.

Discovery product-control endpoints are local-first and share DTOs from
`packages/contracts`:

- `GET /v1/discovery/sources` lists source registry entries merged with
  `source_quality_stats`.
- `POST /v1/discovery/sources` upserts a local source registry entry and emits
  `SourceRegistryEntryCreated` or `SourceRegistryEntryUpdated`.
- `PATCH /v1/discovery/sources/:sourceId/state` changes local source state and
  emits `SourceStateChanged`.
- `GET /v1/discovery/sources/:sourceId/preview` returns local preview leads
  from recent `JobSourceObserved` history for that source; it does not perform
  live scraping.
- `GET /v1/discovery/locator-candidates`, `GET /v1/discovery/quarantine`, and
  `GET /v1/discovery/manual-capture` expose the local review queues. Located
  parseable source candidates are auto-promoted into the active source registry;
  these queues are for blocked, ambiguous, unparseable, or legacy pending work.
- `POST /v1/discovery/locator-candidates/:candidateId/promote` promotes a
  legacy source locator candidate into an active source registry entry and emits
  `SourceLocationCandidatePromoted`.
- `POST /v1/discovery/locator-candidates/:candidateId/reject` removes a local
  source locator candidate from the review queue.
- `POST /v1/discovery/quarantine/:jobKey/decision` approves or rejects a
  quarantined lead and records feedback for source-quality aggregation.
- `POST /v1/discovery/manual-capture/:itemId/import` records user-mediated
  capture provenance for copied URLs, current-page URLs, pasted text, saved
  HTML, and email imports. Raw pasted or saved content is not copied into domain
  events; the API stores only local metadata such as content length and hash.
- `POST /v1/discovery/manual-capture/:itemId/dismiss` dismisses a pending
  manual-capture item.
- `POST /v1/discovery/feedback` records `DiscoveryFeedbackRecorded` with IDs,
  source, kind, and timestamp only; free-form notes stay out of the domain event
  payload.

`/v1/workflow-runs` (PR 5 of the Temporal stack) reads `apply_run_projections`
and projects each row to a `WorkflowRunSummary`, including the Temporal
workflow id (equal to `runId` for apply runs — the Python `ApplyWorkflow`
uses `info.workflow_id` as the timeline key). The web Workflow Runs view at
`/runs` deep-links each row to the local Temporal Web UI
(`http://127.0.0.1:8233`).

`POST /v1/pipeline/actions/run-stage` starts global/batch pipeline stage runs
from the UI. The request accepts `stages`, `limit`, `workers`, `minScore`,
`validationMode`, `dryRun`, score/tailor flags (`rescore`, `retailor`), and
apply flags (`headless`, `model`, `continuous`). The route dispatches
non-apply stages to JSON-RPC `run_stage` and global apply to JSON-RPC `apply`;
it uses the command key `pipeline` only as the local action response handle,
not as a fake job URL. Selected stages run in request order. Non-apply-only
batches are synchronous and return `200` with the worker's real action IDs,
statuses (`dry_run`, `succeeded`, or `failed`), and results. Batches that
include `apply` first run preceding non-apply stages synchronously, then return
`202` only if the apply workflow is actually queued; if apply dispatch fails,
the response is `200` and preserves the dispatcher-derived failed apply action.
`dryRun` defaults to `true`, preserving apply safety.

The `limit` field is forwarded to every stage. For `discover`, the Python
runner passes it into JobSpy, Workday, and Smart Extract and forces bounded
source crawls to run sequentially, skipping remaining sources once the cap is
reached so `limit: 1` is usable for local debugging. For `enrich`, the same
field caps pending detail jobs instead of falling back to the enrichment default
batch size.

Discover honors the profile Target search saved from the Preferences tab.
Target roles replace the active discovery query list, target locations replace
the active location list, and the worker falls back to profile city/country when
target locations are blank. Spain or Europe targets set JobSpy's Indeed country
to Spain, add Europe/remote location accepts, reject America-only non-remote
locations, and filter API-visible America-only source rows from
`GET /v1/discovery/sources`.

The JSON-RPC worker is launched with the API runtime `appDir` as
`JOBHUNTER_DIR`, so API reads, SSE, and Python automation all use the same
local SQLite database. Non-apply pipeline runs also emit pipeline-level
`StageStarted` / `StageCompleted` / `StageFailed` rows, and Discover emits
the same lifecycle rows plus `DiscoveryRunStarted`,
`DiscoveryRunCompleted`, and `DiscoveryRunFailed` for its JobSpy, Workday, and
Smart Extract source steps. Those event types are part of the SSE domain
catalog, so the dashboard can refresh recent activity and source health while a
long synchronous stage request is still running.

`GET /v1/dashboard/summary` includes `activity[].eventType` for those rows so
the web UI can render started, completed, and failed stage states from backend
events instead of local button state alone.

## Related Packages

- `apps/api`: Fastify API app.
- `apps/web`: React/Vite frontend app.
- `packages/contracts`: shared schemas, DTOs, enums, JSON-RPC envelopes, and
  re-exported `@jobhunter/domain-types`.
- `packages/domain-types`: pure TypeScript mirror of the Python domain model.
- `packages/api-client`: typed API client.

The dependency direction is:

```text
apps/api -> packages/contracts -> packages/domain-types
apps/api -> packages/domain-types
apps/web -> packages/api-client -> packages/contracts
```

The API must not depend on `packages/api-client`.

## Commands

```bash
pnpm api:dev
pnpm api:check
pnpm api:test
pnpm qa:test
pnpm web:dev
pnpm web:build
```

The API defaults to `http://127.0.0.1:8766`. The web app proxies `/v1/*` to
that origin unless `VITE_JOBHUNTER_API_BASE_URL` is set.

## Server-Sent Events — `GET /v1/events/stream`

The API exposes a Server-Sent Events endpoint that the frontend's
`SseEventStreamAdapter` (`apps/web/src/shared/adapters/local/`) consumes via
the browser's native `EventSource`. Per
[`docs/frontend-target.md`](frontend-target.md) §7.1, this endpoint is the
single realtime channel from the worker / API write-side to the frontend's
TanStack Query cache; the frontend's `InvalidationRouter` translates each
`DomainEvent` into the right `invalidateQueries` / `setQueryData` calls.

### Request

```
GET /v1/events/stream?tenantId=<tenantId>&since=<lastEventId>
Accept: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
Last-Event-ID: <lastEventId>      # set by EventSource auto-reconnect
```

`tenantId` is recommended; in local mode (`apps/api/src/event-stream.ts`
`resolveTenantId`) it defaults to `LOCAL_TENANT` and any non-`LOCAL_TENANT`
value is silently overridden to `LOCAL_TENANT`. In hosted mode (named-not-built),
the server resolves `tenantId` from the JWT, the JWT-derived tenant is
canonical, and a mismatched query-string value returns `403 Forbidden`.

`since` is optional and is used only by the planned IndexedDB warm-start path
(`docs/frontend-target.md` §9.7) to resume from a persisted watermark on
first connect; the browser's native `EventSource` auto-reconnect uses the
`Last-Event-ID` header instead.

### Response framing

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
X-Accel-Buffering: no

retry: 5000

id: 12345
event: JobScored
data: {"tenantId":"local","jobId":"job-...","fitScore":8,"version":1,"scoredAt":"..."}

id: 12346
event: ResumeApproved
data: {"tenantId":"local","jobId":"job-...","artifactId":"...","generation":2,"approvedAt":"..."}

: keepalive

event: heartbeat
data: {"watermark":12346}
```

Each frame:

- `id: <event_id>` — the row's `event_id` from `job_events`. The browser
  echoes this as `Last-Event-ID` on auto-reconnect.
- `event: <event_type>` — the discriminator from the `DomainEvent` Zod
  schema (e.g., `JobScored`, `ResumeApproved`, `ApplyRunStarted`).
- `data: <payload_json>` — the payload, ready for `JSON.parse`.

### Tenant filtering (COALESCE on the row, not the request)

The server filters `job_events` with the COALESCE on the _event row's_
extracted tenant — falling back to the literal `'local'` string when the
row's `payload_json` lacks a `$.tenantId` key (legacy events written before
`tenantId` was a required payload field):

```sql
SELECT event_id, event_type, payload_json, occurred_at
FROM job_events
WHERE event_id > ?
  AND COALESCE(JSON_EXTRACT(payload_json, '$.tenantId'), 'local') = ?
ORDER BY event_id ASC
LIMIT ?
```

The right-hand `?` is the resolved request `tenantId` (per `resolveTenantId`
above — `LOCAL_TENANT` in local mode; JWT-derived in hosted). The COALESCE
guarantees that legacy `LOCAL_TENANT` rows missing `$.tenantId` still match
the local-mode filter without a write-side backfill.

Tenant scope is mandatory; there is no "all tenants" mode
(`docs/frontend-target.md` §7.8).

### Resume-position precedence

1. `Last-Event-ID` HTTP header (preferred — populated by `EventSource`
   auto-reconnect).
2. `?since=<lastEventId>` query string (fallback for IndexedDB warm-start).
3. `MAX(event_id)` on `job_events` for the resolved `tenantId` (default if
   neither is supplied — first connect streams from the current tail with
   no backfill).

If both header and query are present, `Last-Event-ID` wins.

### Cadences

- **`retry: 5000`** — 5 s reconnect baseline (the browser respects this;
  no application code).
- **`: keepalive`** — comment line every 15 s, keeps reverse proxies and
  CDNs from idling the connection out.
- **`event: heartbeat` with `data: {"watermark":<event_id>}`** — every
  30 s, so the client can verify liveness even when no domain events
  fire. The frontend's AppShell renders a "connection lost" banner if
  no heartbeat or domain event arrives for 30 s.

### Reconnect backstop

On reconnect after a "closed" status of more than 30 s, the frontend's
`EventStreamProvider` fires a one-shot `queryClient.invalidateQueries()`
to recover from any events lost during the gap. `Last-Event-ID` covers the
common case; the full invalidation is a backstop.
