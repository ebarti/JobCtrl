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

## Pipeline Operations Snapshot

`GET /v1/pipeline/operations` returns the current local operations read model.
It takes no query parameters. The API selects the newest Discover execution
that is active or still draining; when none exists it selects the latest
terminal execution. If no execution can be selected, the response still
reports global job-stage backlog and runtime capacity, but its execution,
source-family, and reconciliation summaries are `null`.

The execution identity is the immutable tuple of `workflowId` and
`temporalRunId`. A deterministic Temporal workflow ID can be reused, so the run
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

Cancellation is cooperative and asynchronous: the accepted request is not the
same thing as observing the terminal canceled state.

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

## Implementation Map

| Layer | Owner |
| --- | --- |
| Shared request/response types | `packages/contracts` |
| Typed browser client | `packages/api-client` |
| HTTP, operations snapshot, JSON-RPC, and SSE transport | `apps/api` |
| Durable workflows and activities | `workers/automation` |
| Browser cache and invalidation | `apps/web/src/contexts/operations` |
