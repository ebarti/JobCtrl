# Local Python API

The local Python HTTP application is the browser-facing boundary for JobCtrl's
transformed source runtime. This page keeps its existing documentation URL.
Feature routes call the same application services as CLI and durable workers;
there is no Fastify business authority or TypeScript/Python JSON-RPC hop.

## Shared routes

| Route | Contract |
| --- | --- |
| `GET /v1/health` | Application/schema/workspace identity, selected features, live worker heartbeat and model accounting. |
| `GET /v1/setup/status` | Public Profile/provider/browser/Temporal/policy readiness; configuration and verified readiness are distinct. |
| `GET /v1/settings` | Direct non-secret settings snapshot with integer `revision` and derived read-only `modelAccounting` (selected provider/model, availability, cost source and exact quote). Derivation does not contact providers or inspect credentials. |
| `PATCH /v1/settings` | Partial top-level values plus required `expectedRevision`; returns a new snapshot or 409 for stale input. Nested maps replace the supplied map. |
| `GET /v1/credentials` | Credential configuration/status metadata and shared settings revision; never secret values. |
| `PATCH /v1/credentials` or `/v1/credentials/batch` | Requires `expectedRevision`; stale input performs no native mutation. |
| `DELETE /v1/credentials/{key}` | Requires `?expectedRevision=N`; UI normally uses the batch operation. |
| `/v1/providers/status`, `/v1/providers/models` | Provider readiness and live supported model catalogs. |
| `POST /v1/actions/{action}` | Direct feature payload; optional `Idempotency-Key`; 202 only after confirmed Temporal admission. |
| `GET /v1/action-runs` | Newest-first `{runs,nextCursor,hasMore}`; optional `before` run ID and `limit` from 1 to 200. |
| `GET /v1/action-runs/{runId}` | Current admission/execution result and cancellation state. |
| `GET /v1/action-runs/summary` | Recorded status counts, total, active and pending cancellation counts. |
| `GET /v1/action-runs/by-idempotency-key?action=...` | Exact `Idempotency-Key` header lookup without returning its request payload; a missing row is only an observation at read time. |
| `POST /v1/action-runs/{runId}/cancel` | Empty object; records cancellation before requesting Temporal cancellation. |
| `GET /v1/events/stream` | Committed SSE, replay cursors and optional ordinary-message envelopes. |
| `GET /v1/activity` or `/v1/events` | Newest-first `{events,nextCursor,hasMore}`; optional `before` event ID and bounded `limit`. |
| `GET /v1/activity/{eventId}` | One committed event envelope or 404. |

The health `llmSpend` read model separates `costStatus` and `tokenStatus`, each
`complete`, `unavailable`, `pending` or `unresolved`. A settled native call can
have unavailable monetary cost and complete token usage. `costUsd` is nullable
unless the complete monetary total is known; `knownCostUsd` is only the recorded
subtotal. `costAuthority` describes monetary evidence, while
`accountingComplete` requires both dimensions complete. `activeCalls`,
`unresolvedCalls`, `unavailableCostCalls` and `unavailableTokenCalls` retain the
distinction; `unlimited` reflects the current zero-dollar-cap setting. These are
read-only classifications and do not change receipt or admission policy.

Feature-owned routes cover Profile, Jobs, Requirements, Fit, Resumes and the
retained optional capabilities. Their owners validate input and publish exact
DTOs. Missing optional features remove their routes; unknown API paths return an
explicit 404, including when static frontend assets are served.

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
The scope check and insertion share the SQLite write transaction, including
`pending`, `start_failed`, `queued` and `running`. A competing new identity gets
409 `action_scope_busy` with the existing `runId`; exact same-key/same-body
retries return their original run before this check. A lost acknowledgement
retains its key until exact reconciliation. The Jobs launch pins both the saved
Profile revision and the database incarnation used to read its preferences.

`GET /v1/discovery/runs` includes the canonical run's `failures` list alongside
its counts and status. Board failures identify `sourceFamily`, `unitId`, `boards`,
`code` and a safe actionable `message`; registered-source failures retain their
`sourceId` and code. The action result carries the same recorded failures.
`partial` means at least one source unit completed or reached the new-job limit
while another failed. A completed source may return no jobs. Reaching the limit
records `budget_exhausted`, without asserting upstream provider completion.
If every selected unit fails, the run is `failed`. Per-board request adaptation preserves saved search settings;
see the [Discovery reference](../workers/automation/src/jobctrl/features/discovery/README.md)
for cutoff, checkpoint and restart behavior.

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
same Temporal identity. A different payload with that key returns 409.
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
the shared settings revision without storing secret values in SQLite. Unknown
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
Run lists support literal `status`, `action`, `since` and `until` filters. Health
provides the configured Temporal namespace and a nullable explicit UI base URL;
clients omit workflow links when the UI address is unknown.

Only committed rows are visible. Rollback cannot produce an event for an
uncommitted mutation. The web shell owns one connection and features own their
invalidation rules. Activity is an operational history, not a source of inferred
business or semantic authority.

See [runtime](architecture/runtime.md), [storage](architecture/storage.md), and
[contract ownership](architecture/contracts-types-and-api-boundaries.md).
