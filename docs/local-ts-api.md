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
background `tailor -> cover` pipeline run with `retailor=true`, `dryRun=false`,
and no item limit. The Python materials generation path creates a new materials
generation for each re-tailored job, immediately follows it with cover-letter
generation for jobs that are ready, and preserves the prior generation as
historical/superseded artifact data.
The web Profile, Preferences, Discovery target search, and Settings forms
autosave five seconds after the last edit using the same profile/settings
mutation paths as the explicit Save buttons; failed validation or mutation
errors stay on the local form surface.

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
Tailored resume artifact detail responses include safe tailoring evidence only:
keyword coverage counts for actionable high-signal terms, evidence and quality
summaries, judge/adversarial-review results,
warning-repair status, annotated source-vs-tailored resume changes, high-fit
persona prompt/response audit, and model selection metadata. They do not expose
raw generator prompts, raw profile payloads, or raw job text; annotation and
persona prompt snippets are bounded excerpts of the selected source, tailored
resume, and adversarial-review request.

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
`/v1/jobs/:key` also returns `auditHistory[]`, a user-facing timeline assembled
from allow-listed `job_events` milestones plus append-only apply review and
outcome feedback records. The timeline summarizes discovery, enrichment,
scoring, materials, pipeline, apply, outcome, and job visibility changes without
returning raw event payloads, debug messages, local paths, raw notes, or email
body text.
Job summaries also include source provenance. `discoverySource` is the observed
source registry id where the job was found and falls back to the discovery
strategy/source pair for legacy rows. `postingSource` and `postingSourceUrl`
come from canonical identity evidence when a broad-board result points at a
known ATS or employer-owned posting. The jobs list accepts `minFitScore` and
`maxFitScore` query parameters, plus `applyStatus=applied` for jobs with an
actual applied outcome (`applied_at` present or apply status `applied`). The
same score and applied-outcome filters are accepted by all-matching bulk job
mutations.
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
The jobs list `deleted` filter accepts `active`, `closed`, `deleted`, `hidden`,
or `all`. Closed jobs are non-deleted postings whose active-state verification
marked them unavailable, expired, removed, or location-incompatible; they are
excluded from active lists, dashboard totals, and worker queues while remaining
inspectable from the Closed tab. Deleted jobs are temporary removals: discovery
clears the delete tombstone when the same posting is observed again. Hidden jobs
use a separate `jobhunter_hidden_jobs` tombstone and remain suppressed from
active/deleted/closed lists, dashboard totals, artifacts, workflow runs, and
activity until an unhide mutation clears that hidden tombstone. The API exposes
bulk hide/unhide routes at `POST /v1/jobs/bulk-hide` and
`POST /v1/jobs/bulk-unhide`, plus single-job `POST /v1/jobs/:key/hide` and
`POST /v1/jobs/:key/unhide`. Permanent delete is
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
`packages/contracts`. The web Discovery page composes these endpoints and the
profile-backed Target search settings into source-registry, source-locator,
quarantine-review, role-matching, and manual-capture surfaces; the
source registry renders as a paginated, filterable, sortable table so source
type and policy metadata are visible as columns instead of compact badges:

- `GET /v1/discovery/settings` returns the SQLite-backed runtime discovery
  settings used by board discovery.
- `PATCH /v1/discovery/settings` updates those runtime settings without
  dropping the worker search-contract fields stored in the same row.
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
- `GET /v1/discovery/role-match-feedback` derives a local review queue from
  newly scored jobs with very low fit scores and role-fit evidence. Suggestions
  are exact title-exclusion rules, not automatic prompt or query changes.
- `POST /v1/discovery/role-match-feedback/:suggestionId/decision` approves or
  declines a suggestion. Approved exact-title exclusions are visible in the
  Discovery page and are consumed by future discovery title matching; declined
  suggestions remain recorded but inactive.

`/v1/workflow-runs` (PR 5 of the Temporal stack) reads `apply_run_projections`
and projects each row to a `WorkflowRunSummary`, including the Temporal
workflow id (equal to `runId` for apply runs — the Python `ApplyWorkflow`
uses `info.workflow_id` as the timeline key). The web Workflow Runs view at
`/runs` deep-links each row to the local Temporal Web UI
(`http://127.0.0.1:8233`).
`POST /v1/workflow-runs/:runId/actions/cancel` dispatches a worker-backed
`cancel_run` request for in-flight workflow IDs that are not tied to a concrete
job row, such as global Discover or Apply runs started from the Pipelines tab.
`GET /v1/dashboard/summary` also carries recent apply-run timeline summaries
from `apply_run_projections.events_json` (`type`, `level`, `message`, `at`) so
the Run details drawer renders persisted history without exposing raw event
payloads.

Apply review and outcome feedback endpoints power the local web
`/apply-review` queue and the job-detail outcome timeline. Gmail feedback
ingestion is Gmail-only and runs through the Python worker, not through the
verification-code MCP server:

- `GET /v1/apply/review-queue` returns active apply-stage jobs that are ready
  or close enough for human review, plus materials readiness, latest apply-run
  context, blockers, and latest review state.
- `POST /v1/jobs/:jobKey/apply-review/decision` appends an
  `approve_submit`, `approve_dry_run`, `defer`, `decline`, or `reset`
  decision. Approval records intent only in this slice; it does not dispatch
  the apply worker.
- `GET /v1/outcomes` and `GET /v1/jobs/:jobKey/outcomes` return reviewed
  outcomes and any outcome suggestions.
- `POST /v1/jobs/:jobKey/outcomes` writes a manual reviewed outcome.
- `POST /v1/outcome-suggestions/:suggestionId/decision` accepts, corrects, or
  ignores a pending suggestion and writes a reviewed outcome for accepted or
  corrected suggestions.
- `POST /v1/outcomes/gmail/scan` runs a bounded Gmail feedback scan over known
  application anchors. The request accepts optional `recipientEmail`, `limit`,
  `maxResultsPerAnchor`, and `windowDays` values. The response returns counts
  plus evidence/suggestion IDs, job keys, kinds, and confidence values only; it
  never returns raw Gmail body text.

The web review queue records approval facts only. It only offers submit
approval after a completed dry run. `approve_submit` does not dispatch browser
submission, and `approve_dry_run` does not start a dry run.
Manual outcomes and suggestion corrections require canonical ISO-8601 UTC
`occurredAt` timestamps when the field is supplied.

These routes create `application_review_decisions`, `application_outcomes`,
`application_email_evidence`, and `application_outcome_suggestions`
idempotently in SQLite. Gmail scanning searches only bounded post-application
windows for anchors already known locally, using recipient, employer/ATS,
title/company, application URL/domain, and application timing signals. Full
Gmail bodies are read and stored only after metadata confidently links to a
known application, with provider message ID dedupe. Outcome notes and linked
email bodies may be stored locally, but `job_events.payload_json` stores only
safe IDs, kinds, sources, timestamps, confidence values, link signals, and
note/body presence flags.

`POST /v1/pipeline/actions/run-stage` starts global/batch pipeline stage runs
from the UI. The product-facing stage order is `discover -> apply`: the stage
trigger sends `discover` for preparation and `apply` for browser automation.
The low-level contracts still accept internal `score`, `tailor`, and `cover`
values for compatibility, diagnostics, and maintenance commands, but they are
not primary user-facing stages.

The request accepts `stages`, `limit`, `workers`, `minScore`,
`validationMode`, `dryRun`, the default pipeline LLM model (`llmModel`, default
`gemini:gemini-3.5-flash`), tailoring LLM controls (`tailorModels`,
`tailorJudgeModel`, `tailorJudgeMinScore`), and apply flags (`headless`,
`model`, `continuous`). `model` remains apply-only; scoring, tailoring, and
cover generation use `llmModel` unless a tailoring generator or judge override
is supplied. Low-level internal requests can still pass `rescore` and
`retailor` flags for the `score` and `tailor` maintenance stages. The route
dispatches the ordered stage list to JSON-RPC
`run_stage`, which starts `JobPipelineWorkflow`; when `discover` runs, the
Python runner discovers jobs, drains detail enrichment, and then drains
internal preparation work for scoring, tailoring, cover generation for
successfully tailored jobs, and artifact suppression.
When the selected stage is `apply`, the same `run_stage` request remains inside
`JobPipelineWorkflow`, which delegates to `ApplyWorkflow` as a child workflow.
The dedicated apply JSON-RPC method is used by per-job apply actions, not by
this global/batch run-stage route. The route uses the command key `pipeline`
only as the local action response handle, not as a fake job URL. Successful
workflow starts return `202` with the queued workflow ID. Workflow-start
failures return `200` with the dispatcher-derived failed action.
Queued or accepted starts expose that workflow ID to the Pipelines tab so the
user can stop the in-flight run without resolving a fake `pipeline` job row.
`dryRun` defaults to `true`, preserving apply safety. The apply model defaults
to `default`, which omits `--model` and lets the local Claude Code
configuration choose the active model.

`POST /v1/jobs/:jobKey/actions/run-stage` starts one job-scoped preparation
pickup without resetting stage state. It accepts the internal preparation
stages `enrich`, `score`, `tailor`, and `cover`, rejects product-stage starts
such as `apply`, resolves the route key to the canonical job URL, checks worker
readiness, and dispatches `run_stage` for the remaining preparation sequence
from the requested substage. Before dispatch, the route refreshes projections
and checks that the requested substage is still pending and observably eligible;
known-ineligible rows return `status: "not_eligible"` without starting worker
work. The Jobs page uses this route for eligible viewed rows that are `pending`
on a visible preparation substage, and starts at most one pickup per unchanged
list snapshot so pending preparation continues autonomously without page-render
fanout.

The `limit` field is forwarded to every selected stage. For `discover`, the
Python runner passes it into JobSpy, Workday, Smart Extract, Discovery's
internal detail-enrichment queue drain, and the preparation work-item drains.
Bounded source crawls run sequentially, skipping remaining sources once the cap
is reached so `limit: 1` is usable for local debugging. Detail enrichment uses
the same `limit` and `workers` values as Discovery; `enrich` remains an
internal retry/diagnostic stage, not a top-level product `run-stage` value.

Discovery preparation uses `preparation_work_items` to keep internal subwork
durable and idempotent. The work item kinds are `score_job`, `tailor_resume`,
and `suppress_tailored_artifacts`. The queue emits
`PreparationWorkItemQueued`, `PreparationWorkItemStarted`,
`PreparationWorkItemCompleted`, and `PreparationWorkItemFailed`; the owning
contexts still emit their own events such as `JobScored`,
`TailorRetailorRequested`, `TailoredArtifactsSuppressed`, and
`TailoringPolicyUpdated`. These events are part of the SSE catalog and drive
dashboard, jobs, artifacts, and activity invalidation.

Current-version preparation maintenance actions are separate endpoints:

- `POST /v1/jobs/:jobKey/actions/rescore-current-policy` dispatches
  `rescore_job` for one job.
- `POST /v1/scoring/actions/rescore-current-policy` dispatches
  `rescore_jobs_not_on_current_scoring_policy` for selected or bounded active
  jobs.
- `POST /v1/jobs/:jobKey/actions/retailor-current-policy` dispatches
  `retailor_job` for one job and can suppress the prior active artifacts;
  successful re-tailoring continues into cover generation for that job.
- `POST /v1/materials/actions/retailor-current-policy` dispatches
  `retailor_current_policy` for selected or bounded eligible jobs and can
  suppress prior active artifacts.
- `POST /v1/jobs/:jobKey/actions/retry-stage` resets the selected stage. With
  `runAfter: true`, preparation retries dispatch a job-scoped pipeline workflow
  for the remaining preparation stages (`enrich` -> `score` -> `tailor` ->
  `cover`, starting at the retried stage). `apply` retry still dispatches the
  explicit apply action; retries do not auto-submit applications unless the
  requested stage is `apply`.
- The active Jobs bulk toolbar exposes `retry all failed` outside the failed
  state filter. It posts the current Jobs filters with `state: failed` and
  `deleted: active`, so users can recover failed substages from pending or
  mixed-state views without selecting each failed row first.

First-time manual tailoring is not a re-tailor action. The job detail stage
timeline exposes `POST /v1/jobs/:jobKey/actions/tailor` on the internal
`tailor` stage, dispatching JSON-RPC `tailor_job` for the selected job only.
That explicit user action records a `TailorRequested` audit-history event,
overrides the default low-fit auto-tailoring gate for the selected job without
changing the batch `minScore` behavior, and immediately continues into cover
generation when tailoring succeeds.

The minimum fit score is a live eligibility threshold, not a scoring policy
version. Lowering it can make existing persisted scores eligible for
`tailor_resume`; raising it can make active artifacts ineligible and enqueue
`suppress_tailored_artifacts`. Neither threshold path invokes the scoring LLM.

Discover honors the profile Target search saved from the Discovery page.
Target roles replace the active discovery query list with exact role queries;
target tracks, seniority floors, role areas, and specializations add structured
intent for deterministic recall expansion. The Discovery UI constrains target
tracks to IC, management, and executive, and constrains seniority floors to the
engineering IC, management, and executive ladder choices. Recall queries keep
the same search tier as exact queries because relevance is determined after
discovery by scoring, not by query generation. Recall matching enforces both
track and seniority: IC targets stay IC, management targets stay management,
executive targets stay executive, and a candidate who configures multiple
tracks gets per-track recall. Board discovery settings live in SQLite
`discovery_settings`; source adapters normalize scraped postings into the
shared discovery intake and apply query/location acceptance before a job row or
delete tombstone can be persisted. JobSpy uses
exact-plus-recall queries as broad-board retrieval probes. Direct ATS and
Workday, and source-first Smart Extract sources enumerate
their known board/source and apply that same title intent internally, avoiding
repeated board fetches for each role variant. Smart Extract search-only sources
still fan out by query when the source has no useful browse/all-jobs page.
Canonical ATS rows must also include a usable description before they are
inserted; Greenhouse reads the public board content payload for that text. Each
discover run also performs posting staleness checks that move verified
unavailable, expired, removed, or location-incompatible postings to the closed
lifecycle state, and applies the current title, location, and description
contract to active JobSpy, direct ATS, Workday, and Smart Extract rows so rows
that no longer pass those source-family filters are soft-deleted.
Approved role-match feedback adds a user-reviewed title-exclusion layer on top
of that matcher. The rule scope is exact normalized title text, so approving a
bad low-score pattern suppresses repeat false positives without weakening the
broader exact-plus-recall role family.
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

`GET /v1/dashboard/summary` includes a bounded recent `activity[]` slice with
`activity[].eventType` so the web UI can render started, completed, and failed
stage states from backend events instead of local button state alone. The
top-level Debug tab uses `GET /v1/debug/activity` for the full activity log as a
paginated, sortable table; this keeps Dashboard lightweight without imposing an
event-history cap.

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
