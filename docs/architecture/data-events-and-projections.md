# Data, Events & Projections

The Python target uses feature-owned canonical state, transaction-bound events
and composed read views. HTTP, CLI and the durable worker share the same
application services; a TypeScript business writer or RPC bridge is not part
of cutover. Migration and integrated verification remain in progress.

## Name the layer before changing it

| Layer | Authority |
| --- | --- |
| Canonical state | The owning feature's records and public service: facts, decisions, source revisions and accepted artifacts. |
| Committed event | A bounded invalidation or lifecycle fact appended in the same transaction as its mutation. |
| Read model | A derived view or composition over public owner queries; it may be rebuilt and cannot authorize a different write. |
| Operational metric | A bounded local attempt or status record; it is not proof of an external outcome. |
| Diagnostic telemetry | Optional operational instrumentation; it is not a canonical event, approval or data-recovery mechanism. |

Profile, Jobs, Requirements, Fit, Resumes and other features own their own
schemas. Consumers use public services and recorded IDs instead of sibling
private tables. A feature mutation and its event commit or roll back together.
The Python `app/events.py` store reads committed `app_events` rows; the
implementation rejects event appends outside a transaction. Raw Profile
facts, source text, generated documents, credentials and private mail bodies
must not enter general invalidations.

## Projection Ownership And Consistency

Dashboard, Activity, Evidence Map and Job Detail compose public feature reads.
Any cached/projection state is derived and cannot be treated as a second
canonical writer. Reconcile from source authority after failure and present
stale, unavailable and uncertain values honestly. A failed refresh preserves
last accepted scores and artifacts; no event may make a rolled-back write look
successful. Selected job demand, learning activity and factual capability remain
separate. Offers preserve unknowns and correction history.

## Server-Sent Events

The current in-progress Python adapter at `app/http.py` declares
`GET /v1/events/stream`. It serializes each committed row with an SSE `id`,
`event` and JSON `data`. The data DTO includes `eventId`, `type`, `feature`,
`aggregateId`, `tenantId`, `occurredAt`, `payload`, `level` and `stage`;
`tenantId` is `local` in this local target. `Last-Event-ID` takes precedence
over `after`; `after=latest` starts after the current latest event when no
header is supplied. A future cursor is rejected. `envelope=1` uses `message`
as the SSE event name while retaining the typed DTO. The stream sends
connection and heartbeat comments and emits `workspace_changed` before closing
if its workspace changes. Check the implementation for exact error codes.

The shell owns one connection; feature handlers invalidate or refresh their own
queries. SSE carries bounded invalidations, not source truth or permission to
perform an external action. Current framing is source evidence, not a claim of
completed browser/reconnect or worker integration proof.

## Preparation and durable actions

`app/preparation.py` owns the recipe service; `app/preparation_bootstrap.py`
registers `preparation.run` and `preparation.retry`, and
`app/preparation_http.py` declares `GET /v1/preparation/runs` and
`GET /v1/preparation/runs/{run_id}`. Submit
the actions through `POST /v1/actions/preparation.run` or
`POST /v1/actions/preparation.retry`. Recipes `run`, `discover`, `enrich`,
`analyze`, `score`, `tailor` and `prepare` coordinate public Jobs, Requirements,
Fit and Resumes services and persist per-job step checkpoints; business state
stays with each feature. Preparation does not imply Apply or approve a submission. The shared
`/v1/actions/{action}` and action-run APIs submit, inspect and cancel durable
work. A 202 receipt indicates Temporal accepted the action, not that every step
finished. See [pipeline](pipeline/index.md).

## Verification

Use the real Python application, SQLite, worker, event stream and browser to
exercise commit/rollback, stale saves, reconnect, source ownership and recovery.
The [journey ledger](../developer/qa/python-journeys.md) separates planned
coverage from observed results. Source code alone does not prove integrated
parity.
