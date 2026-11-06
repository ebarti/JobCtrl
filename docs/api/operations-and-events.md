# Operations and Events API

The Python foundation and feature adapters are being integrated. This page
states target semantics, not a completed API inventory or product verification.
HTTP, CLI and the Temporal worker invoke the same Python application actions;
no JSON-RPC bridge or TypeScript business writer remains at cutover.

## Starting Work

The foundation reserves `/v1/actions/{action}` for registered durable feature
actions and `/v1/action-runs/{run_id}` for their runs. A durable submission
returns 202 only after Temporal accepts it. The receipt identifies accepted
work; it does not imply completion, external submission or approval. Features
own validation, idempotency, source fences and external-effect authority.

## Workflow Runs

Reads should expose execution identity, progress, cancellation and truthful
terminal or ambiguous state without leaking sensitive payloads. Cancellation is
a request until actual execution settles. Retries preserve committed work and
must not renew stale approval or repeat an uncertain external effect.

## Pipeline Operations Snapshot

Operational reads distinguish current-run work, explicitly admitted backlog,
global state, source progress, capacity, freshness and uncertainty. A source
finishing is not equivalent to all downstream work finishing.

## Capacity, Active Work, and Task Queue

Capacity and queue details are operational observations, not proof a workflow
completed. Preserve run identity and do not combine independently owned work
into a misleading completion percentage. Exact fields remain subject to the
integrated feature contract.

## Server-Sent Events

The reserved `/v1/events/stream` carries bounded invalidations committed in the
same transaction as the owning mutation. A rolled-back mutation emits no
visible event. Payloads omit credentials, raw Profile evidence and generated
documents. The shell owns one connection; feature handlers re-read or invalidate
their public queries. Errors and reconnection must not manufacture events or
completion. Exact framing and reconnect details require integrated verification.

<a id="health-and-json-rpc"></a>
## Health and Readiness

`/v1/health` is reserved for local readiness. Health must distinguish API,
worker and durable-execution availability where relevant; a blocked probe alone
does not prove a service is down. The earlier JSON-RPC health contract is
retired at cutover. Inspect the integrated implementation and independent
listener/process evidence before changing runtime state.

The health response distinguishes the path-scoped workspace identity from
`databaseInstanceId`, which identifies the actual database file incarnation.
The lookup `GET /v1/action-runs/by-idempotency-key?action={action}` takes the
key in the `Idempotency-Key` header and can find an accepted action; a 404 is
an observation, not proof that an in-flight admission can never complete.

## Implementation Map

The provisional composition, HTTP, event and durable-action interfaces are in
the [foundation contract](../plans/2026-11-06-python-contracts.md). Feature
adapters are in `workers/automation/src/jobctrl/features/`; shared infrastructure
is in `workers/automation/src/jobctrl/app/`. The
[pipeline reference](../architecture/pipeline/index.md) owns operational
invariants. Real integrated journeys are required before declaring parity.
