# Local Python API

The local Python HTTP application is the browser-facing boundary for JobCtrl's
transformed source runtime. This page keeps its existing documentation URL.
Feature routes call the same application services as CLI and durable workers;
there is no Fastify business authority or TypeScript/Python JSON-RPC hop.

## Shared routes

| Route | Contract |
| --- | --- |
| `GET /v1/health` | Application/schema/workspace identity, selected features, live dispatch readiness and model accounting. |
| `GET /v1/setup/status` | Public Profile/provider/browser/PostgreSQL/DBOS/worker/policy readiness; configuration and verified readiness are distinct. |
| `GET /v1/settings` | Direct non-secret settings snapshot with integer `revision` and derived read-only `modelAccounting` (selected provider/model, availability, cost source and exact quote). Derivation does not contact providers or inspect credentials. |
| `PATCH /v1/settings` | Partial top-level values plus required `expectedRevision`; returns a new snapshot or 409 for stale input. Nested maps replace the supplied map. |
| `GET /v1/credentials` | Credential configuration/status metadata and shared settings revision; never secret values. |
| `PATCH /v1/credentials` or `/v1/credentials/batch` | Requires `expectedRevision`; stale input performs no native mutation. |
| `DELETE /v1/credentials/{key}` | Requires `?expectedRevision=N`; UI normally uses the batch operation. |
| `/v1/providers/status`, `/v1/providers/models` | Provider readiness and live supported model catalogs. |
| `POST /v1/actions/{action}` | Direct feature payload; optional `Idempotency-Key`; 202 after action acceptance and DBOS enqueue commit. |
| `GET /v1/action-runs` | Newest-first `{runs,nextCursor,hasMore}`; optional `before` run ID and `limit` from 1 to 200. |
| `GET /v1/action-runs/{runId}` | Current admission/execution result and cancellation state. |
| `GET /v1/action-runs/summary` | Recorded status counts, total, active and pending cancellation counts. |
| `GET /v1/action-runs/by-idempotency-key?action=...` | Exact `Idempotency-Key` header lookup without returning its request payload; a missing row is only an observation at read time. |
| `POST /v1/action-runs/{runId}/cancel` | Empty object. Records Stop for the selected run and returns its current receipt. A 202 means delivery is pending. A 200 returns an acknowledged request or a terminal receipt. |
| `GET /v1/events/stream` | Committed SSE, replay cursors, optional database-scoped resume IDs and ordinary-message envelopes. |
| `GET /v1/activity` or `/v1/events` | Newest-first `{events,nextCursor,hasMore}`; optional `before` event ID and bounded `limit`. |
| `GET /v1/activity/{eventId}` | One committed event envelope or 404. |

An action run's `cancellationRequested` records the saved Stop. Its
`cancellationDelivery` is `pending` while delivery remains unconfirmed and
`acknowledged` once DBOS confirms the request. Receipts omit the field
when neither state applies. Retry pending delivery with the same run ID.
An acknowledgement leaves `status` active until the worker or durable execution confirms the outcome.
Terminal receipts from earlier versions may lack delivery evidence.

The health `llmSpend` read model separates `costStatus` and `tokenStatus`, each
`complete`, `unavailable`, `pending` or `unresolved`. A settled native call can
have unavailable monetary cost and complete token usage. `costUsd` is nullable
unless the complete monetary total is known; `knownCostUsd` is only the recorded
subtotal. `costAuthority` describes monetary evidence, while
`accountingComplete` requires both dimensions complete. `activeCalls` counts all
running model receipts with a live owner, including calls admitted on earlier
UTC days. `dailyActiveCalls`, each `lanes[].active` count, both usage statuses,
amounts, `unresolvedCalls`, `unavailableCostCalls` and `unavailableTokenCalls`
relate to calls admitted on the reported UTC day. Predecessor responses omit
`dailyActiveCalls` and count only today's running calls in `activeCalls`.
`unlimited` reflects the current zero-dollar-cap setting. These are
read-only classifications and do not change receipt or admission policy.
`dailyBudgetUsd`, `accountingBlocked`, `monetaryAccountingBlocked` and
`tokenAccountingBlockedLanes` derive from the same settings/receipt snapshot.
The blockers describe historical uncertain or unavailable usage under enabled
limits, not running-call progress or known usage reaching a ceiling. An empty
blocked-lane list means no finite token lane lacks the evidence required for
admission. Digest carries these blockers plus both active counts and the daily unresolved count; unknown
history alone no longer makes its budget status incomplete. Exact amounts and
knowledge statuses remain unchanged even when accounting does not block work.

Feature-owned routes cover Profile, Jobs, Requirements, Fit, Resumes and the
retained optional capabilities. Their owners validate input and publish exact
DTOs. Missing optional features remove their routes; unknown API paths return an
explicit 404, including when static frontend assets are served.

The Jobs URL form submits `POST /v1/actions/jobs.capture_url` with `{ "url": "…" }`,
an `Idempotency-Key` and `Expected-Database-Instance-Id`. The 202 response
identifies the durable run. `GET /v1/jobs/url-imports` returns its source URL,
run ID, current status, cancellation request and delivery state, failure code
and captured job ID.
The mounted Jobs feature advertises `jobs.url_import_queue` in the health
response’s `capabilities` array when it supports this projection. For older
servers the form uses the same action receipt and links to the filtered native
run history at `GET /v1/action-runs?action=jobs.capture_url`.
An active matching URL returns `action_scope_busy` with the existing run ID.
Transient lane or monetary serialization is visible as `waiting_for_capacity`.
The synchronous `POST /v1/jobs/import-url` returns a captured posting or an
immediate error for clients that explicitly use it.

`GET /v1/jobs/{job_id}/requirements/attempts/latest` reads the latest attempt
and any recorded refusal details, even before a job has accepted Requirements.
The snapshot read still returns null until an accepted revision exists.

The reusable requirement library reads `/v1/requirements`,
`/v1/requirements/{id}` and bounded `/v1/requirements/{id}/history` pages
(`kind=revisions|occurrences`, `limit` up to 200, `offset`). Original posting
occurrences remain distinct from canonical meanings and expose accepted-snapshot
and current-source status separately. `/v1/fit/requirement-library` joins the
catalog to recorded achievement assessments and exact approved-wording coverage;
it also lists explicit user associations labeled unassessed. An absent Profile
returns `readiness: "profile_required"` without hiding the catalog.

`POST /v1/fit/associations` requires a stable client association ID, expected
Profile revision, exact requirement revision, achievement source pins and any
optional exact wording binding. The same ID and payload reuse the saved result.
`POST /v1/fit/associations/{id}/state` soft-removes or restores under
`expected_revision`; restoration retains original pins and may remain stale.
Only one active association per achievement/requirement pair is allowed;
`POST /v1/fit/associations/{id}/revisions` changes its optional wording or exact
source pins with a fresh Profile/association revision fence. The bounded
`/{id}/history` reader preserves earlier revisions. These are
user-intent records, never qualification, coverage, wording approval or model
admission. See the [Fit owner reference](../workers/automation/src/jobctrl/features/fit/README.md)
and [Requirements owner reference](../workers/automation/src/jobctrl/features/requirements/README.md)
for exact fields and source-authority boundaries.

`requirements.correct_occurrences` is a version-fenced durable correction of
1–20 selected reusable occurrence meanings; its direct route is
`POST /v1/jobs/{job_id}/requirements/corrections`. It preserves unselected
meaning, binding, evidence and authority, uses a single source-bound revision
batch followed by complete-catalog matching, and records separate correction
provenance. Reasons are guidance rather than evidence. See
[the typed Requirements API](api/jobs-and-materials.md#typed-job-requirements)
for payload, retention and durable call limits.

Maintained wording is separately exposed in the Fit library's `current_wordings`
and `wording_assignments`. `POST /v1/fit/current-wordings` selects an exact
approved variant with a current positive coverage receipt under Profile and
assignment revision fences. Each achievement/requirement pair has one head.
Manual changes cannot introduce multiple maintained alternatives; the existing
manual affected-matches workflow must record a complete grouped justification.
`/{id}/state` removes or source-validates restoration, and bounded `/{id}/history`
retains earlier assignment revisions. Selection changes invalidate their
fingerprint without changing Profile approvals, coverage receipts or accepted
document bytes.

`fit.refresh` declares one active admission per profile. A different idempotency
key for an already pending, queued or running scope receives
`action_scope_busy` with the existing `runId`; an exact retry uses its original
identity. Its required saved-input stamp prevents queued work from absorbing
later edits. Cancellation and transport recovery finalize the feature's
operation receipt in the same transaction as the action transition. See the
[Fit reference](../workers/automation/src/jobctrl/features/fit/README.md) for
scope, progress and limit fields.

`discovery.search` also registers one active admission scope per workspace.
The scope check and insertion share the PostgreSQL write transaction, including
`pending`, `start_failed`, `queued` and `running`. A competing new identity gets
409 `action_scope_busy` with the existing `runId`; exact same-key/same-body
retries return their original run before this check. A lost acknowledgement
retains its key until exact reconciliation. The Jobs launch pins both the saved
Profile revision and the database incarnation used to read its preferences.

`GET /v1/discovery/sources` returns boards from the installed JobStreaming registry and their local state. Change an existing board with `PATCH /v1/discovery/sources/{source_id}/state` and its `expectedRevision`. A preview reads saved observations. Automatic searches run exclusively through JobStreaming. Jobs independently owns the durable `jobs.capture_url` action for a supplied posting URL.

New saved searches use the exact role titles and location/work-arrangement
filters from the pinned Profile revision. `discovery.refresh_targets` records
those literal inputs for inspection. Role matching uses the saved preferences
when a posting is returned.

`GET /v1/discovery/settings` defaults to `boards: ["linkedin"]` when a workspace
has no saved board selection. Saved selections and explicit per-run overrides
can include Indeed and ZipRecruiter.

`GET /v1/discovery/runs` includes the canonical run's `failures` list alongside
its counts and status. Board failures identify `sourceFamily`, `unitId`, `boards`, `code` and a safe actionable `message`. Historical records retain their original source identifiers. The action result carries the same recorded failures.
New SDK board access failures keep the code `discovery_provider_authentication_configuration`.
Their optional `diagnostic` is `missing_credential`, `provider_access_denied`,
`tls_configuration`, `proxy_configuration`, or `authentication_or_configuration`.
An identified HTTP denial includes `httpStatus` (401 or 403). A committed
`DiscoveryRunUpdated` warning at stage `board_search` includes the same
failure in `payload.sourceFailure` before the SDK acknowledges the event.
Terminal SDK board rate limits use `discovery_provider_rate_limited` and set
`diagnostic` to `rate_limited` in the warning and run result. A terminal board
rate limit stops that board's remaining query and location units for the run.
LinkedIn listing and detail requests share a four-second minimum interval across
runs. Every LinkedIn HTTP 429 pauses that board. JobCtrl honors a positive
`Retry-After` and the minimum request interval. Without a usable header it
uses exponential backoff with jitter and a 120-second ceiling. While the
deadline is outstanding, the run stays active.
Each entry in `cooldowns` includes `retryAtEpochSeconds` (absolute Unix time)
and `retryAfterSeconds` (remaining wait). The worker counts time spent offline
toward that same deadline. The same run automatically
resumes pending acquisition unless cancelled or its job limit is already met.
The run list also explains rate limits from historical records that stored this
code with a generic message.
Historical action receipts and already-published events retain their original fields.
`GET /v1/events?aggregateId={run_id}&type=DiscoverySourceRateLimited` lists
individual LinkedIn HTTP 429 responses, including attempts that the SDK recovered
from. Each event includes `receivedAt` (UTC), `unitId`, `phase` (`listing`,
`detail`, or `other`), `leaseEpoch`, `elapsedMs` since the discovery run started,
and cumulative `responses` for that run and board through the reported 429. `retryAfterSeconds`
is the provider's requested delay or `null` when the header is absent or
unusable. New events also record the effective deadline in `retryAtEpochSeconds`.
New LinkedIn HTTP 429 events also include `ordinaryRequestIntervalSeconds`,
the workspace-wide spacing for ordinary requests after this response (4–16 seconds).
The saved retry deadline controls the interrupted request.
On an observed LinkedIn 429, `requestedAt` is the UTC transport dispatch time.
When an earlier request sample is available in that run for the same board,
`previousRunBoardRequest` contains its dispatch time, phase and HTTP status,
and `requestStartIntervalMs` gives the difference between the two dispatches.
The first request and older records can lack a previous sample. The timing
covers the Discovery search transport. Its response counters retain their
listing, detail and other totals.
For targeted posting details, `receiptKey` identifies the saved listing.
`DiscoverySourceRetryResponse` joins the subsequent HTTP response to that
deadline, unit and phase, with the receipt key when available. Its UTC
`requestedAt` and `receivedAt` distinguish dispatch from response time, and
`httpStatus` records the board's reply.
The source's `politeness.rateLimitedCount`
continues to describe recent runs that settled with a rate-limit failure.
`partial` means at least one source unit completed or reached the new-job limit
while another failed. A completed source may return no jobs. Reaching the limit
records `budget_exhausted`, without asserting upstream provider completion.
If every selected unit fails, the run is `failed`. Per-board request adaptation preserves saved search settings;
see the [Discovery reference](../workers/automation/src/jobctrl/features/discovery/README.md)
for cutoff, checkpoint and restart behavior.

`GET /v1/discovery/runs/{run_id}/jobs/{job_id}/role-target` reads the current
saved job's judgment against that run's frozen role preferences. A missing
decision is `null`. `POST` on the same route takes `expectedPostingRevision`
and can assess a saved job from an earlier run that recorded a target plan.
The response identifies the posting revision, source hash, plan, verdict,
source citations and model receipt. Review preserves the job, its original
admission and its Fit score. Foreign run membership, absent frozen targets and
stale writes are refused. Repeating a POST for the same revision returns its
recorded decision or failure. An in-flight or interrupted role call returns
`discovery_role_call_unsettled` and its outcome needs review.

In the complete product, the same `discovery.search` identity stays active
through Preparation's initial fit-only `search` recipe. Source status remains
independent: the composite result exposes `acquisitionStatus` and its own
`status`, with `ok: false` for a partial outcome. If acquisition failed after
committing new jobs, those exact retained jobs are still assessed and the
composite is partial; the canonical source run remains failed. The separate
`preparation` summary and explicit selected-job `assess` recipe are defined in
[Operations and events](api/operations-and-events.md#starting-work).
Cancelled/failed action terminalization seals interrupted preparation in the
same transaction, including recovery without re-entering the feature handler.
It never settles model accounting. Completed failed/blocked stages retain their
original outcome on same-run replay; an explicit new retry admits further work.

## Action and error semantics

Synchronous operations return 200/201. A durable command returns, for example:

```json
{"runId":"uuid","workflowId":"workspace-scoped-id","status":"queued"}
```

Queued is not completed. Run status is `pending`, `queued`, `running`,
`succeeded`, `failed`, `cancelled` or `start_failed`. A failed start confirmation
may be uncertain. Retry with the same idempotency key and payload, which reuse the
same durable workflow identity. A different payload with that key returns 409.
Recovery clients retain the non-secret `databaseInstanceId` from health and send
`Expected-Database-Instance-Id` on status reads and writes. A mismatch returns
`workspace_changed` 409 before route execution, preventing an uncertain request
from being admitted into a replacement database at the same workspace path.

Errors use `{"error":{"code":"...","message":"...","details":{}}}`;
`details` is optional. Stale saves preserve the accepted version. Provider or
renderer failures preserve the previous accepted artifact and expose the failed
attempt separately. Cancellation can be requested while an external action is
settling; its owner reports a truthful final or ambiguous outcome.

## Settings and security

Settings include explicit provider/model selection, Codex reasoning effort,
lane concurrency/token limits, daily spend policy, worker capacity, Apply limits,
qualification threshold/guidance, resume mode and AI execution policy. Tailored
resume composition is the default. Explicit baseline mode remains available and
requires no resume model call. Automatic approved-Applications execution is off
by default and still requires exact existing approvals when enabled.

Requests must have a loopback Host and actual loopback peer. Browser mutations
require a configured first-party local origin; native clients use the private
local capability token. Extension routes require the paired token and have
additional task/installation admission. An extension origin cannot read arbitrary
Profile or credential endpoints.

Credential reads serialize with the OS-user mutation lock. Missing mutation
revisions return 428; stale revisions return 409. Native-only writes increment
the shared settings revision without storing secret values in PostgreSQL. Unknown
helper ownership returns `credential_store_unavailable` with
`details.reason=ownership_unverified`, preserving the recovery record.

## Committed events

Each event contains `eventId`, `type`, `feature`, `aggregateId`, `tenantId`,
`occurredAt`, explicit `level`, nullable `stage`, and a bounded identifier/invalidation `payload`. SSE uses the event
ID as `id`. Default `event` is the named event type; `?envelope=1` uses `message`
while retaining the type in the JSON body. Reconnect uses `Last-Event-ID` or the
`after` query parameter. A replaced database emits `workspace_changed` and closes
the subscription.
`after=latest` starts at a snapshot of the current committed cursor; a reconnect's
`Last-Event-ID` takes precedence. HEAD returns finite stream headers without
starting an event loop.

Activity supports literal `feature`, `type`, `level`, `stage`, `aggregateId`,
`since`, `until` and `q` filters. Search does not interpret SQL wildcard characters.
Run lists support literal `status`, `action`, `since` and `until` filters. Health reports storage, DBOS and worker readiness without requiring a workflow
UI link.
Only committed rows are visible. Rollback cannot produce an event for an
uncommitted mutation. The web shell owns one connection and features own their
invalidation rules. Activity is an operational history, not a source of inferred
business or semantic authority.

See [runtime](architecture/runtime.md), [storage](architecture/storage.md), and
[contract ownership](architecture/contracts-types-and-api-boundaries.md).

The local `/v1/health` response reports workspace and database identity, storage,
DBOS and worker readiness. A reachable database alone does not prove a compatible
worker is ready. Stable action and workflow identities allow an idempotent retry
after lost acknowledgement. A different payload with the same key is rejected.
