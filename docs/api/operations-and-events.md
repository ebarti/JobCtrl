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
| HTTP, JSON-RPC, and SSE transport | `apps/api` |
| Durable workflows and activities | `workers/automation` |
| Browser cache and invalidation | `apps/web/src/contexts/operations` |
