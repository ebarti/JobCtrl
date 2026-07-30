---
description: "Learn why JobCtrl runs Temporal workflows inside a local desktop product for recovery, retries, visibility, cancellation, and bounded automation."
---

# Temporal Workflows In A Desktop App

Temporal is usually discussed as server infrastructure. JobCtrl runs Temporal
locally because a desktop job-search workflow still needs durable execution:
the laptop can sleep, providers can fail, workers can restart, and
employer-facing actions cannot be retried casually.

## A Desktop Workflow Is Still Distributed

JobCtrl presents one local web application, but several processes collaborate:

- the web app renders product state and sends structured actions;
- the local TypeScript API validates requests and serves read models;
- a JSON-RPC bridge starts Python-owned work;
- the Python worker executes workflow activities;
- Temporal records workflow history, timers, retries, and cancellation;
- SQLite and registered local files hold domain facts and artifacts.

These processes can fail independently even though they share one computer.
Treating a long operation as one browser request would tie its lifetime to a
tab, an API connection, or an in-memory process. Temporal gives the operation a
separate durable identity.

The full process boundary is documented in
[Runtime & Processes](../architecture/runtime.md).

## Workflows Coordinate; Activities Perform Side Effects

Temporal workflow code decides sequence, retries, and branching from recorded
history. Activities perform non-deterministic work such as SQLite access,
network requests, model calls, browser operations, rendering, and event
persistence.

That separation lets Temporal replay orchestration without repeating arbitrary
in-workflow I/O. JobCtrl’s long-running entry points all start workflows rather
than falling back to a hidden in-process runner.

Representative workflow shapes include:

| Workflow responsibility | Durable behavior |
| --- | --- |
| Discover | Coordinates source families, resumable search units, enrichment, and per-job preparation |
| Job preparation | Runs the required score, tailor, cover, and PDF subset in canonical order for one job |
| Apply | Uses job-scoped identity and sink-specific retry rules for guarded application work |
| Profile import and compensation refresh | Moves heavy operations off the long-lived request thread |
| Durability probe | Uses an inert durable timer to prove recovery without network, model, browser, or Apply work |

The exact catalog and code pointers live in
[Temporal Workflows](../architecture/pipeline/index.md).

## Stable Identity Prevents Accidental Parallel Work

Some actions should have one active execution for a given target. JobCtrl uses
deterministic workflow identifiers where duplication would be unsafe. Starting
the same identity while it is running returns the existing execution instead of
creating a second one.

The Temporal run ID still matters because a deterministic workflow ID can be
used again after a prior execution closes. JobCtrl records both. Read-model
reconciliation pins its lookup to the exact run so an old failure is not
confused with a later execution using the same logical identity.

Other orchestration uses a fresh run identity when independence is correct.
Identity is therefore a domain decision, not a global “deduplicate everything”
switch.

## Retries Follow The Side Effect

A transient source fetch and a live submission do not share one retry policy.
JobCtrl classifies errors and bounds activity attempts according to the
operation:

- retryable provider or network failures can retry within a named activity
  policy;
- permanent validation and budget errors fail fast;
- per-stage score and model retries are bounded;
- idempotent preparation steps report `already_done` when replay finds
  completed work;
- live employer-facing intent is not blindly retried after ambiguity.

The workflow provides the recovery mechanism, while the domain decides whether
repetition is safe. That is why durable orchestration improves safety only when
activity boundaries and idempotency rules are explicit.

Read
[Activities, Retries & Cancellation](../architecture/pipeline/envelope.md) for
the current policies and
[At-most-once Job Application Submission](at-most-once-job-application-submission.md)
for the high-risk example.

## Workflow History Becomes Product Visibility

Temporal’s own history is an execution authority, but raw workflow events are
not a friendly product interface. JobCtrl records bounded `Workflow*` and
`PipelineStep*` domain events and folds them into local read-model projections.
The Runs and Pipelines workspaces then combine durable lineage with fresh
worker and task-queue telemetry.

This supports questions a desktop user actually asks:

- Is this run still active, draining admitted work, complete, failed, or
  canceled?
- Which jobs and steps belong to this exact Discover execution?
- Did a worker restart leave work running?
- Is an estimate based on fresh capacity or stale telemetry?
- Can I safely start a replacement run?

The UI does not infer completion from a finished source crawl when downstream
preparation remains. It also does not call a failed workflow proof that the
runtime is idle.

## Reconciliation Repairs Gaps Without Inventing History

Each workflow records a start marker and a terminal outcome through activities.
The starter also writes an open row immediately after Temporal accepts a start,
covering executions that close before their first activity.

A heartbeat reconciler compares projected runs with the exact recorded Temporal
run. If history is temporarily unavailable, JobCtrl records a provisional
not-found state and keeps checking. If the authoritative run returns, a
compensating event reopens it or applies its real outcome; the false terminal
remains in the audit stream.

For older Discover runs, bounded history reconstruction can rebuild exact
membership and step keys. During that recovery, the UI labels the state and
withholds unsupported selected-run counts and estimates instead of displaying
partial data as truth.

The detailed projection and recovery contract is in
[Operations & Events](../architecture/pipeline/operations.md).

## Local Scheduling Remains Explicit

Temporal also supplies a local recurring schedule for discovery. It is disabled
by default. When enabled, worker startup reconciles one cron schedule with
skip-overlap behavior, so a slow execution does not overlap the next tick.

This is not a hosted background service: the local Temporal server and JobCtrl
worker must be running. The standing Apply loop is likewise an explicit local
setting, appears as a normal workflow run, and remains subject to Apply safety
and spend controls.

## The Tradeoff

Running a workflow engine locally adds processes, a history store, task queues,
and operational concepts to a desktop product. A small synchronous utility
would not need that machinery.

JobCtrl accepts the overhead because its core workflow is long-running,
multi-stage, provider-dependent, and partly employer-facing. Durable history,
classified retries, cancellation, recovery, and visible ownership are product
features rather than backend implementation details.

Use the [Product Tour](../user/product-tour.md#runs) to see run history, or
follow [Getting Started](../user/getting-started.md) to start the bundled local
runtime.

Related reading:

- [Local-first Job Search Automation](local-first-job-search-automation.md)
- [At-most-once Job Application Submission](at-most-once-job-application-submission.md)
- [JobCtrl Guides](index.md)
