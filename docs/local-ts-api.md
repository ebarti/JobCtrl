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
Profile-data writes also record `ProfileUpdated` in `job_events`. When existing
tailored resumes are present, the API handles that event by dispatching a
background `tailor` pipeline run with `retailor=true`, `dryRun=false`,
and no item limit. The Python materials generation path creates a new materials
generation for each re-tailored job and preserves the prior generation as
historical/superseded artifact data.

Read-model endpoints (`/v1/dashboard/summary`, `/v1/jobs`, `/v1/jobs/:key`,
`/v1/artifacts`, `/v1/workflow-runs`) read from the local `*_projections` tables
maintained by `apps/api/src/projections.ts` (TS-side mirror) and the Python
`ProjectionBuilder` (`workers/automation/src/jobhunter/infrastructure/projections/`).
Both processes refresh projections idempotently via the shared
`event_watermarks.operations_projections` watermark.
Artifact detail routes include `GET /v1/artifacts/:artifactId` for metadata and
`GET /v1/artifacts/:artifactId/preview.pdf` for inline preview of registered
PDF artifacts. The preview route serves only known PDF artifact files from the
local artifact projection; it returns `404` for missing metadata/files and
`415` for non-PDF artifacts. The separate `POST /v1/artifacts/:artifactId/open`
route still delegates to the local OS opener.

`/v1/jobs` and `/v1/jobs/:key` expose the latest persisted scoring evidence
from `job_scores` as additive read-model fields: `scoreBreakdown`,
`scoreKeywords`, `scoreVersion`, `scoredAt`, `scoreTrace`, and
`scoreStaleness`. `scoreTrace` includes policy-facing metadata such as scoring
policy version, rubric version, calibration adjustment, and policy anchor
counts without exposing raw policy anchor payloads. `scoreStaleness` reports
unresolved stale markers, including the stale reason, current and target policy
versions, marked time, and whether the score is waiting for explicit rescore
reset. `scoreReasoning` remains on the wire as a compatibility summary during
the scoring evidence migration.
Job summaries also include source provenance. `discoverySource` is the observed
source registry id where the job was found and falls back to the discovery
strategy/source pair for legacy rows. `postingSource` and `postingSourceUrl`
come from canonical identity evidence when a broad-board result points at a
known ATS or employer-owned posting. The jobs list accepts `minFitScore` and
`maxFitScore` query parameters, and the same score bounds are accepted by
all-matching bulk job mutations.
`POST /v1/jobs/:key/score-correction` writes a new corrected `job_scores`
version, records `ScoreCorrected`, and updates the versioned `scoring_policies`
table with a correction-derived calibration anchor. It mirrors the Python
`CorrectScoreUseCase` policy update path because this local API mutation writes
directly to SQLite instead of crossing the Python JSON-RPC boundary. When the
policy version changes, the API also marks comparable latest uncorrected scores
stale in `job_score_staleness`; corrected score versions are not marked stale.
`POST /v1/scoring/stale-scores/actions/reset-for-rescore` clears active stale
markers and resets their score stage to `pending` for an explicit rescore. The
body accepts `jobKeys` for selected stale scores or an empty list for all active
stale scores, plus optional `limit` for bounded resets. The backend command
that consumes those reset jobs is `jobhunter run score --rescore` or the batch
API action with `stage: "score"` and `rescore: true`.
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
`POST /v1/jobs/bulk-retry-failed` accepts the same selected-job or
all-matching bulk mutation body and resets each active failed or exhausted job's
failed stage to `pending`; non-failed selected jobs are ignored.

`/v1/dashboard/summary` includes `sourceHealth[]`, sourced from
`source_quality_stats`. The projection is rebuilt from discovery run,
source-observation, duplicate, content snapshot, enrichment, apply-URL, and
active-state events and user discovery feedback. It is the read-side signal the
web dashboard uses for source health. The same response also includes
`operationalMetrics`, sourced from `operational_attempt_metrics`, plus
per-source operational/scrape/retryable failure counts. These counters use
structured stage/source/apply attempt rows, not label math over free-text event
messages.

Discovery product-control endpoints are local-first and share DTOs from
`packages/contracts`. The web Discovery page composes these endpoints into
source-registry, source-locator, quarantine-review, and manual-capture tabs; the
source registry renders as a paginated, filterable, sortable table so source
type and policy metadata are visible as columns instead of compact badges:

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
  JobSpy direct URLs feed this same loop: runnable ATS URLs are promoted into
  the source registry, while unknown owner URLs or ATS URLs that still need
  adapter configuration remain visible for review.
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
apply flags (`headless`, `model`, `continuous`). The route dispatches the
ordered stage list to JSON-RPC `run_stage`, which starts `JobPipelineWorkflow`;
if the list includes `apply`, that workflow delegates the apply step to
`ApplyWorkflow` as a child workflow after preceding stages complete. The route
uses the command key `pipeline` only as the local action response handle, not
as a fake job URL. Successful workflow starts return `202` with the queued
workflow ID. Workflow-start failures return `200` with the dispatcher-derived
failed action.
`dryRun` defaults to `true`, preserving apply safety. The apply model defaults
to `default`, which omits `--model` and lets the local Claude Code
configuration choose the active model.

The `limit` field is forwarded to every stage. For `discover`, the Python
runner passes it into JobSpy, Workday, and Smart Extract and forces bounded
source crawls to run sequentially, skipping remaining sources once the cap is
reached so `limit: 1` is usable for local debugging. For `enrich`, the same
field caps pending detail jobs instead of falling back to the enrichment default
batch size.

Discover honors the profile Target search saved from the Preferences tab.
Target roles replace the active discovery query list with exact role queries;
target tracks, seniority floors, functions, and specializations add structured
intent for deterministic recall expansion. Recall queries keep the same search
tier as exact queries because relevance is determined after discovery by
scoring, not by query generation. Recall matching enforces both track and
seniority: IC targets stay IC, management targets stay management, and a
candidate who configures both tracks can receive both. JobSpy uses
exact-plus-recall queries as broad-board retrieval probes. Direct ATS and
Workday, and source-first Smart Extract sources enumerate
their known board/source and apply that same title intent internally, avoiding
repeated board fetches for each role variant. Smart Extract search-only sources
still fan out by query when the source has no useful browse/all-jobs page.
Canonical ATS rows must also include a usable description before they are
inserted; Greenhouse reads the public board content payload for that text. Each
discover run also applies the current title, location, and description contract
to active JobSpy, direct ATS, Workday, and Smart Extract rows and soft-deletes
rows that no longer pass those source-family filters.
Target locations replace the active location list, and the
worker falls back to profile city/country when target locations are blank. The
API validates target locations as real places before saving profile preferences.
Hybrid and on-site target work models search and filter only the target
location. Remote target work models search and filter the target country, and
European countries also add an Europe-remote search and accept pattern.
Profile-driven discovery searches at least the last 30 days unless local config
sets a larger window. Spain or Europe targets set JobSpy's Indeed country to
Spain, reject America-only non-remote locations, and filter API-visible
America-only source rows from `GET /v1/discovery/sources`. Discover limits are
new-job budgets: duplicate/rediscovered observations do not consume the cap.

The JSON-RPC worker is launched with the API runtime `appDir` as
`JOBHUNTER_DIR`, so API reads, SSE, and Python automation all use the same
local SQLite database. The API also passes `expectedAppDir` and
`expectedDbPath` into worker-started workflows. Worker activities verify those
runtime values before writing, and fail non-retryably if the Temporal worker is
connected to a different local app directory or SQLite database. The worker
writes `worker_runtime_heartbeats` into the same database; `GET /v1/health`
returns the API app/database identity plus the latest worker heartbeat status.
The web topbar surfaces missing or stale worker heartbeats, and the pipeline
stage trigger blocks new worker-backed actions until the worker is healthy.
Non-apply pipeline runs also emit pipeline-level
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
