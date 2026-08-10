# Operations & Events API

This route family starts and observes work. The TypeScript API validates a user
command, dispatches JSON-RPC to the Python runtime, Temporal owns durable
execution, projections expose progress, and SSE tells the browser what to
refresh.

For every method and status code, use the
[complete contract](complete-contract.md#pipeline-and-preparation-actions).

## Starting Work

| Route family | Use |
| --- | --- |
| `POST /v1/pipeline/actions/run-stage` | Start a global stage run. |
| `POST /v1/jobs/:jobKey/actions/run-stage` | Start a stage for one job. |
| Per-job action routes | Apply, tailor, generate materials/prep, retry, cancel, mark applied/skipped. |
| Scoring/materials policy actions | Rescore or re-tailor stale/current-policy work. |

An asynchronous start returns `202 Accepted` with run/workflow identity after
Temporal accepts the workflow. Eligibility no-ops and synchronous commands use
`200`; invalid input or a failed start returns an error.

`POST /v1/jobs/:jobKey/actions/retry-stage` has two distinct commands. A plain
reset (`runAfter: false`) is local and synchronous. A reset-and-run
(`runAfter: true`) checks worker readiness before the reset; on
`503 worker_runtime_unavailable`, the failed/blocked stage and its event history
are preserved exactly so a dispatch precondition cannot erase retry evidence.
An accepted reset clears prior execution-owner metadata before returning the
stage to `pending`, so a canceled predecessor cannot reclaim explicitly retried
work before its replacement workflow is queued. Pending Enrich pickup reads the
canonical `job_enrichments.current_status`; a stale legacy or list-projection
description cannot falsely classify a reset aggregate as already enriched. A
repeated pickup cannot skip a queued or running upstream preparation stage to
start a downstream stage concurrently. Score, Tailor, and Cover pickup also
require the canonical enrichment aggregate to be `enriched` with a non-empty
canonical description; projected legacy text cannot unlock downstream work.
The compatibility `runId` returned by workflow-start RPC remains the workflow
handle ID. Durable stage ownership and workflow audit use
`firstExecutionRunId`, the exact Temporal execution ID; they never substitute
the compatibility handle for execution identity. If a legacy dispatcher omits
an exact execution ID, the API leaves Enrich pending for the selected worker
activity to claim with its runtime identity instead of persisting a fake owner.
Activity timeout, worker shutdown, and workflow cancellation are not synonyms:
the first two release unfinished Enrich ownership for Temporal retry, while an
explicit cancellation terminalizes only the exact owned cohort. Each selected
stage passes only its canonical successful JobIds downstream. Selected Tailor
and Cover batches honor the requested bounded worker count; durable item
failures remain on their rows while the approved subset continues. Explicitly
selected batches receive a replay-versioned activity deadline of 30 minutes per
worker wave, capped at 6 hours, while the separate 2-minute heartbeat timeout
continues to detect worker loss.

## Pipeline Operations Snapshot

`GET /v1/pipeline/operations` returns the current local operations read model.
It takes no query parameters. The API selects the newest Discover execution
that is active or still draining; when none exists it selects the latest
terminal execution. If no execution can be selected, the response still
reports global job-stage backlog and runtime capacity, but its execution,
source-family, and reconciliation summaries are `null`.

`projectionCoverage` reports whether exact selected-execution lineage is ready.
It is `null` only when no execution is selected and fresh, available runtime
telemetry proves `activeSlots = 0`. Unavailable, stale, or occupied runtime
inventory without a selected execution reports `recovering`; the API never
fabricates an idle or ready checkpoint. For a selected execution:

- `ready` includes native/reconstructed mode, decoder version, Temporal history
  event watermark, verified membership/step counts, and checkpoint timestamp;
- `recovering` includes expected and persisted counts while the worker rebuilds
  and verifies the exact durable key sets;
- `retrying` carries the same progress fields plus a bounded error code for a
  safe automatic retry; and
- `incomplete` carries the verified partial counts and bounded terminal reason
  when immutable legacy history ended before the complete target set was
  recorded. It is not retried automatically.

Only `ready` permits selected-run completion counts or ETA scope to be treated
as exact. The checkpoint is revalidated against current row counts and a
cross-runtime canonical key digest on every read; a stale `ready` row is
downgraded and selected for worker repair.

For reconstructed legacy runs, decoder v2 derives preparation ownership from
append-only workflow-start events inside each exact fanout-attempt interval and
requires the recovered per-pass workflow count to equal the declared target
count. Folded workflow projections and runtime telemetry cannot supply or
promote that lineage. Retry attempts retain their exact attempt/start/completion
facts without inventing a missing queue timestamp. A terminal failed fanout
publishes `incomplete` with its exact partial dispatch set instead of remaining
in an automatic retry loop.

The execution identity is the immutable tuple exposed as `discoverWorkflowId`
and `discoverRunId` (the Temporal run ID). A deterministic Temporal workflow ID can be reused, so the run
ID is required to distinguish executions. Membership is split into two
execution-owned cohorts:

- `observed_this_run`: jobs first linked to this run by a source observation;
- `existing_backlog`: eligible work swept into this execution from before the
  run. If a swept job is later observed by a source in the same run, the one
  membership row is promoted to `observed_this_run`; it is never duplicated.

The response exposes three non-overlapping operational scopes:

| Scope | Meaning |
| --- | --- |
| `current_execution` | Work for jobs in `observed_this_run`, plus execution-owned orchestration steps. |
| `execution_sweep` | Per-job stage work for this execution's `existing_backlog` cohort. Stages without a separately attributable sweep queue report `not_separate`. |
| `global_outside_execution` | Canonical per-job stage backlog not linked to either selected-execution cohort. It does not invent global orchestration or PDF queues. |

`sourceFamilies` and `reconciliation` are separate from downstream stage
backlog. Source-family progress counts the planned family crawls only;
reconciliation reports enrichment passes and preparation fan-out. Neither is
presented as whole-pipeline completion. The selected execution phase is one of
`discovering`, `draining`, `completed`, `completed_with_issues`, `failed`, or
`canceled`. Both execution cohorts participate in the delivered phase
calculation: unresolved current jobs or swept backlog can keep a successful
Discover workflow in `draining`, while a closed membership with failed or
inconsistent planning/terminal steps produces `completed_with_issues`.

While the selected execution's `family:jobspy` source step is running,
`sourceFamilies.providerProgress` may expose the latest normalized
JobStreaming traversal observation: `site`, `phase`, `unit`, completed and
optional total units, optional raw-items-seen count, jobs emitted, and optional
continuation status. The API binds the event to both the exact Discover
workflow ID and Temporal run ID, omits it when the source step is terminal, and
never exposes the provider cursor, checkpoint, resume token, raw provider
payload, or other continuation state.

The Dashboard/Pipelines progress projection may include
`sourceProgress.recoveredUnits` for the compatibility-named `jobspy` family.
It counts immutable JobStreaming query/location/board units reclaimed by a
newer Temporal activity attempt and is rendered as `N resumed` when positive.
It does not expose checkpoint JSON, provider payloads, activity owner tokens,
or raw provider errors.

Per-job `enrich`, `score`, `tailor`, and `cover` counts come from canonical
`job_stage_states`. Execution-owned planning, source-family, reconciliation,
fan-out, backlog-sweep, and PDF lifecycle comes from attempt-aware
`pipeline_step_projections`. Pipeline-step rows fill orchestration visibility
gaps; they do not replace the per-job stage source of truth.

### Capacity, Active Work, And Task Queue

The operations reader derives the expected application directory from the
configured database path, filters heartbeats to that resolved database/app-dir
identity, selects the Temporal task queue named by the newest matching
heartbeat, and aggregates fresh schema-valid rows from that queue.
`configuredSlots`, `activeSlots`, and `availableSlots` count every activity
slot. The active-item inventory is a separate, bounded diagnostic view: only
allowlisted activity kinds are displayed, the oldest 20 items are returned, and
`activeItemsTotal` / `activeItemsTruncated` distinguish exact allowlisted
cardinality from the bounded list. A worker may therefore have more active
slots than visible items.

The worker interceptor does not inspect activity arguments. Displayed
identifiers are either validated safe workflow/run references or non-reversible
local `op_...` hashes; URLs, job descriptions, profiles, prompts, provider
outputs, artifact paths, payloads, credentials, and exception text do not enter
the heartbeat detail boundary.

Temporal task-queue statistics are a separate infrastructure signal. Workflow
and activity poller counts, approximate backlog count/age, and add/dispatch
rates are observations, not domain-job totals. Unsupported, unavailable, and
stale observations remain typed states instead of being converted to zero.
`activeStageCounts` is the exact fresh runtime-activity total grouped by known
operational stage, or `null` when runtime telemetry is not fresh. It explains
which stages currently occupy the shared activity pool but cannot promote
`projectionCoverage` or prove selected-execution completion.

### Freshness And ETA

The snapshot has explicit freshness/capacity/task-queue variants, so callers
must render stale, unsupported, and unavailable data honestly. Its estimator
version is `pipeline-eta-v1`. Every numeric ETA requires fresh capacity, at
least five successful duration samples for each relevant remaining stage, and
bounded shared-queue contention. The overall ETA additionally waits for
execution membership to close; per-stage and source-family ETAs can estimate
their already-known scoped backlog while membership remains open. The estimator
uses recent canonical stage/projection durations, reports a low/high range,
confidence, basis, sample size, timestamp, and caveat, and rounds outward.
Otherwise the response returns a typed `calibrating`, `paused`, `stale`, or
`unavailable` reason such as `membership_open` (overall ETA only),
`worker_unavailable`, `budget_exceeded`, `telemetry_stale`, or
`contention_unbounded`. The range is an operational estimate, not a completion
promise.

The web query treats the endpoint as a live snapshot: it is stale after 10
seconds, polls every 15 seconds while the selected execution is discovering or
draining and every 60 seconds otherwise, and does not poll in the background.
Durable workflow, stage, preparation-item, and pipeline-step events also
invalidate it through SSE. Polling remains necessary because worker heartbeats
and task-queue observations are runtime telemetry, not domain events.

## Workflow Runs

`GET /v1/workflow-runs` lists all workflow types. `GET
/v1/workflow-runs/:runId` returns the projection-backed detail and timeline.
`POST /v1/workflow-runs/:runId/actions/cancel` requests Temporal cancellation.

Discover, job preparation, and Apply use this same history contract: one status
vocabulary, ordered lifecycle timeline, terminal-state interpretation, and
cancellation boundary. Product views may present different workflow details,
but they do not maintain separate run-state rules.

When a `JobPreparationWorkflow` or `JobPipelineWorkflow` input contains one
canonical `jobId`, the list and detail responses resolve `jobKey`, `title`, and
`company` from the tenant-scoped job projection. The Runs workspace keeps the
workflow as the page identity and exposes that related job as a separate link.

The list accepts an exact `workflowType`, inclusive UTC `startedSince`, and
exclusive UTC `startedBefore` in addition to status, sorting, and pagination.
Filtering happens after lifecycle folding and before pagination, so restarted
executions use their canonical projected start time and returned totals cover
the complete filtered result rather than only the current page.

Cancellation is cooperative, asynchronous, and idempotent: accepting a request
is not the same thing as observing terminal `canceled`, and repeating the
request cannot overwrite an already-terminal result or emit duplicate
cancellation transitions. Terminal results remain inspectable through the same
run detail after cancellation wins or loses the race with completion.
`WorkflowCancellationRequested` is a separate timeline fact containing the
requester, source boundary, optional reason, request time, and exact Temporal
run. A delivered JobCtrl request is recorded as `request_intent`; the immutable
Temporal history requester is recorded separately as `temporal_history`, so a
failed local delivery can neither masquerade as the cancellation nor suppress
the authoritative requester. Local mode records `local_operator` through
`jobctrl_api`; it does not invent an authenticated account. Cancellations issued
outside JobCtrl are backfilled from Temporal's requester identity (for example,
`temporal_cli`). If a previously observed Temporal requester must be restored
after the dev namespace retention window has purged that execution, the audit
uses the distinct `recovered_temporal_history` evidence kind and says so in the
timeline; it is never presented as a fresh history read or a JobCtrl request.

## Debug Activity

`GET /v1/debug/activity` and `GET /v1/debug/activity/:eventId` expose a nullable
`workflowId` derived from the canonical event payload. Free-text `q` search
includes that workflow ID, so a run's **Review activity** action returns the
events for that exact workflow instead of broad job history or an empty result.
Worker stage runners stamp that ownership at the source: pipeline-level stage
events and per-job stage events recorded while a Temporal run executes carry
the run's canonical workflow ID in their payload, across the activity's
blocking executor and per-stage thread fan-out. Events recorded outside a run
(CLI one-offs) carry no workflow ID and stay job-scoped only.

The activity detail route always preserves the selected event as its page
identity. When the projection has related job or workflow identity, the page
renders explicit **Open related job** and **Open related run** links; activating
an event row never silently replaces the event view with a job redirect.

## Health And JSON-RPC

`GET /v1/health` distinguishes API process health from worker readiness. A
command that requires the worker must fail clearly when the JSON-RPC/Temporal
path is unavailable; the API must not manufacture a successful queued state.

`POST /v1/_internal/rpc` is the internal dispatch boundary. Public browser code
uses typed product routes rather than calling arbitrary worker methods.

## Server-Sent Events

`GET /v1/events/stream` tails durable tenant-scoped events and frames them as
typed Server-Sent Events. The client:

1. validates each event,
2. maps its type to affected query keys,
3. invalidates or safely patches the cache, and
4. lets projection reads reconcile the UI.

Event IDs support reconnect replay; keepalives preserve quiet connections. See
the [frontend realtime design](../architecture/frontend/realtime.md) for cache
behavior and the [complete SSE contract](complete-contract.md#server-sent-events-—-get-v1eventsstream)
for framing and precedence rules.

The browser patches a tenant-scoped cache row only when the event carries
enough canonical data to do so truthfully. That includes active job detail,
already-registered artifact detail, workflow-run detail, and ordered Apply-run
events. List membership, filtered views, dashboards, missing payload fields,
and uncertain artifact registration use bounded tenant-scoped invalidation
instead. Realtime reconciliation preserves view-owned filters, selection,
pagination, and scroll position; it never inserts a phantom artifact merely
because a generation event arrived.

## Implementation Map

| Layer | Owner |
| --- | --- |
| Shared request/response types | `packages/contracts` |
| Typed browser client | `packages/api-client` |
| HTTP, operations snapshot, JSON-RPC, and SSE transport | `apps/api` |
| Durable workflows and activities | `workers/automation` |
| Browser cache and invalidation | `apps/web/src/contexts/operations` |
