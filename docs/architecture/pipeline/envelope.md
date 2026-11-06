# Durable Execution Envelope

The target uses Temporal for long-running work. The Python application registers
feature-owned actions and the worker executes the same application behavior used
by HTTP and CLI. This integration is in progress; do not infer a completed
runtime from the contract alone.

## Start, execution and acknowledgement

A request validates its inputs, caller authority and source revisions before
admission. Durable submission returns an accepted receipt only after Temporal
accepts the workflow; acceptance does not mean completion. Execution retains
request/run identity and exposes a truthful status and safe failure detail.
Features own idempotency, source checks and any external-effect authorization.
A retry cannot create fresh approval or silently repeat an ambiguous action.

## Cancellation, recovery and deadlines

Cancellation should stop further work where possible and distinguish requested,
completed and unknown outcomes. Recovery reconciles durable state against actual
execution rather than inventing success or discarding already committed work.
A failed replacement preserves the last accepted artifact. Model operations
apply lane/spend preflight and preserve provenance, including unresolved usage.
Blocking I/O must not prevent required activity heartbeats and cancellation from
being observed; bounded timeouts must reflect the external operation.

<a id="run_blocking_with_heartbeat"></a>
The legacy `run_blocking_with_heartbeat` name is a historical reference, not a
requirement that the new runtime use a particular helper. The above behavior,
not the helper name, is the contract.

See [operations](operations.md), [integration](../domain-model/integration.md)
and the [foundation interfaces](../../plans/2026-11-06-python-contracts.md).
