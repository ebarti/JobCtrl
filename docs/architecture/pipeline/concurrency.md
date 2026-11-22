# Concurrency and Fan-out

The target retains bounded durable work, but exact capacity, fan-out and task
queue behavior must be verified in the integrated Python application. This page
states reliability requirements, not measured throughput or a guarantee that
migration is complete.

## New-search cohort preparation

New search admissions persist their execution policy with the action in the
same transaction. Existing actions return their retained admission unchanged;
queued legacy work and retries keep their original policy and request IDs.
Pending preparations promote to running explicitly, and cancellation seals
pending as well as running work.

The fixed cohort of up to ten newly discovered jobs uses bounded, ordered workers for independent
model lanes. Within each job, accepted prerequisite results and exact posting
versions still gate subsequent work. Saved lane capacities remain admission
limits; they are not raised to enable overlap. A finite daily monetary cap
retains serial execution because its spend guard excludes concurrent model
calls. Larger cohorts keep the per-job preparation policy. The route is stored
with the frozen target IDs, before model work. A request that exceeds the model
size limit reports the refusal through its recorded stage outcome.

New searches record the single-job Requirements input format when their action
is admitted. Searches already in the queue and retries of those searches use
their original format for every target. On the per-job route, the current
format shares repeated field lists, verbatim strings and citation path layouts
within each complete catalog comparison. It preserves the exact source and
segment identities and every required assignment. The worker still settles each
comparison before the next. Distinct source material can exhaust the 1 MiB
request bound before the last target in a large search.

Enrichment, role analysis, Requirements and Fit scoring wait when an active
model call holds their lane or a finite monetary policy serializes provider
calls. The action retains its stage and emits a `PreparationWaitingForCapacity`
event with the run, job (for per-job work), stage and capacity reason. Each
attempt to acquire capacity rechecks current accounting and cancellation. The
gateway allocates the receipt together with the owner's Requirements or initial
cohort Fit reservation after admission succeeds. Provider execution occurs once
outside the capacity wait. Exhausted spend, unresolved accounting and provider
failures retain their own outcomes.

Requirements stages exact extraction results without presenting them as
accepted requirements. One owner determination then reconciles every incoming
cohort member and the complete retained catalog, including hidden meanings.
Job/extraction-scoped incoming identities prevent unrelated local IDs from
colliding. Atomic publication checks the catalog and every affected posting and
snapshot; a stale result makes no partial catalog change.

After that producer barrier, Fit freezes all final demands, Profile facts,
assessment heads and destination score heads. It reuses exact current
qualifications and sends the distinct missing bindings in one batch. A shared
qualification commit validates the complete frozen cohort. Subsequent per-job
score commits consume only those frozen accepted assessments and existing
deterministic arithmetic; changed or absent authority fails without recapturing
sources or calling the model again.

Staging, model completion, owner publication and per-job score publication have
separate durable identities. Recovery distinguishes a completed receipt from an
unsettled call and a committed domain result from a missing preparation
checkpoint. It never grants another provider allowance to repair an uncertain
acknowledgement. Accepted artifacts and truthful partial outcomes survive.

The [cohort decision](../../decisions.md#_2026-11-17-bounded-cold-search-cohort-preparation),
[Requirements owner](../../../workers/automation/src/jobctrl/features/requirements/README.md)
and [Fit owner](../../../workers/automation/src/jobctrl/features/fit/README.md)
define the exact boundaries. The [QA ledger](../../developer/qa/python-journeys.md)
records observed proof. Real search timing runs from admission through all
required stages and final currentness; a warm zero-call pass is a separate
measurement.

## Where Fan-out Happens (And Why)

Discovery can acquire from multiple configured sources; job preparation and
other features can run independently where their source and approval inputs
permit it. Concurrency must respect source policy, configured budgets, worker
capacity, run ownership and explicit cancellation. Committed work survives an
interruption; retry must not duplicate a job, artifact, action or external send.
An optional feature's removal must not silently substitute a legacy path.

## Apply Launcher Admission

Application work must fence concurrent claims and recheck exact, current
approval and prior-application authority before any owned external effect.
Once intent exists, an uncertain result is not safely retried as a new send.
[Apply containment](../../developer/security.md#apply-path-containment) owns
the security boundary.

## Saved Posting Check Bounds

Posting checks and other recurring work must have bounded ownership and capacity,
respect explicit cancellation and preserve the last known evidence on failure.
Status must distinguish an unavailable result from a proven closed posting.
Exact schedule and capacity behavior remains subject to the retained-capability
inventory and integrated journey verification.

## Evidence and change control

Use the [historical search-unit assessment](search-unit-concurrency-assessment.md)
only for its dated measured implementation and synthetic cohort. It is not a
benchmark of the transformed runtime. New capacity claims require measurement
on the actual candidate with owned synthetic data and controlled external
boundaries; elapsed time alone does not prove correctness or provider safety.
