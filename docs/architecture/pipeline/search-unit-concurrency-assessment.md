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
| Wall time p50 / p95 | 5.124 s / 5.147 s | 5.092 s / 5.101 s |
| Time to first accepted p50 / p95 | 86.4 ms / 91.8 ms | 36.5 ms / 38.2 ms |
| Adapter service p50 / p95 | 54.5 ms / 60.4 ms | 0.2 ms / 0.3 ms |
| Limiter wait p50 / p95 | 936.6 ms / 953.6 ms | 994.5 ms / 1.005 s |
| Acceptance/persistence p50 / p95 | 4.5 ms / 6.1 ms | 4.4 ms / 5.4 ms |
| Checkpoint save p50 / p95 | 0.11 ms / 1.09 ms | 0.11 ms / 1.07 ms |

All six units completed in every measured repeat. Every repeat produced exactly
six job rows, six acceptance receipts, and six checkpointed units, with one
adapter active at most. Removing the 50 ms synthetic service wait reduced median
wall time by about 33 ms (0.6%). The diagnostic competing-call arm still took
5.079 s, kept all five start gaps at or above 1.0 s, and observed a maximum of
one active call.

The timings overlap and must not be added as a decomposition. In particular,
the acceptance timer wraps `store_jobspy_results`, and checkpoint-save timing
observes the synchronous checkpoint persistence invoked by acknowledgement,
not the entire `stream.ack` call.

Cancellation and retry probes used the same production durable consumer:

| Scenario | Observed result |
| --- | --- |
| Pending cancellation | All six units canceled without starting an adapter; returned in 35 ms. |
| Active provider wait | JobStreaming's cancellation-aware wait stopped; all six units canceled 54 ms after the signal. |
| Host-limiter wait | No adapter started, but return took 927 ms after the signal because the current limiter sleep has no cancellation input. |
| Provider retry | One synthetic transient failure retried once, then completed with one job, one receipt, and checkpoint revision 4 in 5.107 s. |

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

The focused regression set also covers store-before-ack replay, checkpoint loss,
the exact result limit before and after acknowledgement, stale-attempt fencing,
pending and active cancellation, provider retry/reset, host spacing, and the
shared budget boundary. These tests exercise the existing production consumer
and repository rather than a parallel fake loop.

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
revision `cb5a01b97b226fb96d8affcbde0858d49effda77`, using
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
