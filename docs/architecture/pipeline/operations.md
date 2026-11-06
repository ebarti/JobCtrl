# Workflow Operations and Recovery

This page records the target operational contract. Feature migration and
integrated verification are in progress; exact UI fields and endpoint payloads
must be read from the candidate's feature adapters and product-path evidence.

## Pipeline Operations Snapshot

The operations view should distinguish execution identity, current-run work,
explicit backlog work, global state, source progress, capacity, freshness and
uncertainty. Source acquisition completing does not prove all downstream work
completed. Events and projections are derived from canonical owners and must
never expose private source text, credentials or generated document content.

## Discovery Run Progress

Track the actual run and its accepted work, source outcomes, failures and
remaining work. Bounded limits apply to the run across retries and recovery;
receipts/checkpoints must not turn replay into duplicate accepted jobs. Preserve
provenance and distinguish an interrupted run from a user-requested stop.

## Discovery Schedule

Recurring discovery is off by default. Enabling, changing or disabling a
schedule is an explicit user action. An update must not silently launch work or
interpret the schedule as approval for an external application submission.

## Recurring Saved Posting Checks

Bound recurring checks and report their actual outcomes. An unavailable or
failed check is not proof a posting closed; preserve prior evidence until a new
result is accepted. Cancellation must stop further work as far as the transport
permits.

## Automatic Preparation Recovery

Recovery may resume work whose source/version and authorization are still valid.
It must preserve committed progress, respect the user's stop and avoid replacing
accepted artifacts on failure. Job-specific scoring, composition and operations
remain owned by their respective features rather than a second business writer.

## Domain Events, Projections and SSE

Feature mutations and bounded invalidations commit together. SSE reads committed
events and the client invalidates the owning feature's queries. Read-side
projections are derived views, not permission to bypass ownership, and must be
reconcilable after interruptions. See [integration](../domain-model/integration.md)
and [events API](../../api/operations-and-events.md#server-sent-events).

## Spend Ceiling

Model-backed work performs lane/spend preflight before external calls. Provider
failures, invalid responses, source changes and exhausted budgets stay distinct;
none permits lexical fallback or destruction of an accepted artifact. Actual
usage and unresolved accounting must remain inspectable without disclosing
private inputs.

## Verification

The target recurring suite uses real application/API/database/worker/renderer
entry points with only external LLM, job and provider boundaries controlled.
It must exercise cancellation/restart, stale writes, failed refreshes,
approvals and ambiguous effects with owned synthetic workspaces. Static checks
and builds remain; the one-off Profile transfer proof is separate. See
[local reliability QA](../../local-reliability-qa.md).
