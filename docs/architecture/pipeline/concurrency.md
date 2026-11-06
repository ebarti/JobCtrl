# Concurrency and Fan-out

The target retains bounded durable work, but exact capacity, fan-out and task
queue behavior must be verified in the integrated Python application. This page
states reliability requirements, not measured throughput or a guarantee that
migration is complete.

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
