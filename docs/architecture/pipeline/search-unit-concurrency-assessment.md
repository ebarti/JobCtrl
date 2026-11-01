# Search-Unit Concurrency Assessment (#899)

**Decision:** keep durable broad-board search units sequential. The bounded
synthetic evidence does not justify a runtime pool, lease change, provider-policy
change, or another `claim_next` consumer.

This assessment measures the current JobCtrl and JobStreaming 0.0.5 path. It is
not a real-provider throughput or safety claim. The fixed adapters make timing
repeatable while the production `run_discovery` consumer, JobStreaming gateway,
real `HostRateLimiter`, SQLite search-unit leases, checkpoints, acceptance
receipts, and job persistence remain in the path. Every sample uses a fresh
owned temporary database, registered synthetic adapters, and a process-level
outbound socket block.

The complete machine-readable samples, invariants, commands, runtime details,
git revision, platform, dependency version, and lock hash are in the
[raw assessment artifact](/artifacts/search-unit-concurrency-899.json).

## Fixed Cohort And Policy

Each measured arm used the same six immutable units: three queries (`Director
of Engineering`, `VP Engineering`, and `Platform Engineering Manager`) crossed
with the synthetic Indeed and LinkedIn adapters at `Remote`. Each unit emitted
one accepted listing. One warmup preceded three measured repeats.

The benchmark read the effective constants from the owning code:

| Boundary | Measured value |
| --- | ---: |
| Minimum start interval on the shared `jobspy` host key | 1.0 s |
| Maximum concurrent requests on that host key | 1 |
| Durable search-unit invocation budget | 500 per execution |
| Default parallel source families | 1 |
| Default worker activity slots | 4 |

The baseline adapter waited 50 ms per unit. The control removed only this
service wait; it retained the same host policy, cohort, gateway, durable path,
and persistence. The competing-call arm used the same number of calls and the
real limiter, but deliberately omitted durable consumption; the artifact labels
it diagnostic rather than concurrent production.

## Results

| Measurement | Current policy baseline | Zero-service control |
| --- | ---: | ---: |
| Wall time p50 / p95 | 5.144 s / 5.159 s | 5.089 s / 5.091 s |
| Time to first accepted p50 / p95 | 98.3 ms / 98.7 ms | 36.5 ms / 36.8 ms |
| Adapter service p50 / p95 | 53.6 ms / 60.4 ms | 0.2 ms / 0.3 ms |
| Limiter wait p50 / p95 | 940.0 ms / 950.6 ms | 994.9 ms / 1.005 s |
| Acceptance/persistence p50 / p95 | 4.9 ms / 6.0 ms | 4.1 ms / 5.0 ms |
| Checkpoint save p50 / p95 | 0.13 ms / 1.09 ms | 0.11 ms / 1.08 ms |

All six units completed in every measured repeat. Every repeat produced exactly
six job rows, six acceptance receipts, and six checkpointed units, with one
adapter active at most. Removing the 50 ms synthetic service wait reduced median
wall time by about 55 ms (1.1%). The diagnostic competing-call arm still took
5.100 s, kept all five start gaps at or above 1.0 s, and observed a maximum of
one active call.

The timings overlap and must not be added as a decomposition. In particular,
the acceptance timer wraps `store_jobspy_results`, and checkpoint-save timing
observes the synchronous checkpoint persistence invoked by acknowledgement,
not the entire `stream.ack` call.

Cancellation and retry probes used the same production durable consumer:

| Scenario | Observed result |
| --- | --- |
| Pending cancellation | All six units canceled without starting an adapter; returned in 45 ms. |
| Active provider wait | JobStreaming's cancellation-aware wait stopped; all six units canceled 60 ms after the signal. |
| Host-limiter wait | No adapter started, but return took 926 ms after the signal because the current limiter sleep has no cancellation input. |
| Provider retry | One synthetic transient failure retried once, then completed with one job, one receipt, and checkpoint revision 4 in 5.106 s. |

The limiter result is an observed responsiveness gap, not evidence that the
service was unavailable. For the ordinary one-second policy it can add nearly
the remaining spacing interval before cancellation is noticed. Within-cap
`Retry-After` waits can be longer, and the same limiter loop remains
non-interruptible between its bounded sleeps.

## Lease And Limit Evidence

`claim_next` intentionally returns an already-running lease when the owner token
and activity attempt match. A second loop sharing that identity therefore gets
the same unit instead of the next pending unit. A different owner at the same
attempt is stale and rejected. Naively starting multiple consumers would either
duplicate the active unit or fail the fence; the current repository does not
provide pool-worker allocation semantics.

The assessment now records four loss/recovery probes through the same production
`run_discovery` consumer, JobStreaming gateway, SQLite repository, and real
`HostRateLimiter`. Each retry used a new activity owner and attempt, while the
limiter instance and durable execution remained shared:

| Synthetic probe | Interrupted state | Recovered result |
| --- | --- | --- |
| Store before acknowledgement | One running unit, checkpoint revision 0, one job and one receipt | Attempt 2 recovered the unit once and completed at checkpoint revision 3; one job and one receipt remained. |
| Limit 1, loss before acknowledgement | Running/pending units, revisions 0/none, one job and one receipt | Both units became skipped; the result remained exactly one new job and one receipt. |
| Limit 1, loss after acknowledgement before skip | Running/pending units, revisions 1/none, one job and one receipt | Both units became skipped; the result remained exactly one new job and one receipt. |
| Tiny invocation budget 2 | Running/pending/pending units after the first invocation failed before acknowledgement | Recovery consumed invocation 2; claiming the next unit made the durable count 3 and recorded one `budget_exhausted` blocked outcome. The first unit completed at revision 3, the other two were skipped, and only two adapter calls, one job, and one receipt occurred. |

All four probes made two adapter calls with two observed limiter acquisitions.
Their retry start gaps were 1.000--1.009 seconds, maximum provider concurrency
was one, and every recorded invariant passed. The tiny-budget probe is a
deliberate synthetic policy override for boundary assessment; it does not alter
the production budget of 500 or imply a safe real-provider request budget.

The focused regression set also covers same-owner lease reentry,
stale-attempt fencing, pending and active cancellation, provider retry/reset,
and host spacing. The new smoke regression asserts the artifact's receipts,
checkpoints, recovery counts, terminal states, exact limits, and budget outcome
through the real limiter. No parallel fake loop supplies this evidence.

## Assessment

Parallel durable units cannot improve this cohort under the current policy:
the whole JobStreaming stream holds the shared `jobspy` slot, whose host
concurrency is one, and the fixed start spacing dominates the measured wall
time. Raising host concurrency or changing provider pacing would be a separate
provider-policy decision that this synthetic workload cannot support. Source
families already have their own bounded fan-out, defaulting to one against four
worker activity slots.

A future runtime proposal would first need material contract changes and fresh
authorized provider evidence. At minimum it would need distinct pool-worker
lease ownership, an atomic execution-wide exact-result limit, one shared
execution invocation budget, cancellation-aware limiter acquisition and waits,
and proof that store-before-ack/checkpoint replay remains fenced across
consumers. Those changes are outside this assessment and are not justified by
the current measurements.

## Reproduction And Limits

The artifact records the exact observed invocation. It ran with the existing
project `.venv` at Python 3.14.4 and JobStreaming 0.0.5 on arm64 macOS, from git
revision `d17d1ccfa3032e52697cb1638e0df52b1b625f03`, using
`workers/automation/uv.lock` SHA-256
`4eaf563541a57070c8e1b661d34aad441d419ef8811dbd02abdc64b267148a67`.

The requested locked `uv --locked --all-extras --exclude-newer false` command
was also attempted. With uv 0.12.17 it stopped before execution because the
pre-existing, deliberately preserved dirty lock contains relative
`exclude-newer` metadata and uv reports that the lock must be updated when the
global exclusion is removed. The assessment did not rewrite or stage that lock.
This environment limitation is separate from the successful direct-venv
benchmark and test results, and the raw artifact preserves the actual Python
executable used.

No live scrape, provider request, credential, production database, migration,
application submission, release, deployment, or merge was performed.
