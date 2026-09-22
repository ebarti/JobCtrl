# Local Scale Benchmark

The local scale benchmark is a reproducible, synthetic baseline for JobCtrl's
production read paths. It creates a new owned temporary app directory, config,
SQLite database, and artifact directory for each dataset, initializes the
database with the exact schema-v10 constructor, and removes the workspace after
the dataset finishes. It has no flag for an existing app directory or database.

Run it from the repository root with a new output path:

```bash
corepack pnpm benchmark:local-scale --json-out /tmp/jobctrl-local-scale.json
```

The command refuses to overwrite its output. It removes provider credentials
from the RPC subprocess environment, disables Langfuse export, and routes any
unexpected outbound proxy traffic to an unreachable loopback port. The only RPC
method is the read-only `provider_models` method. The benchmark does not invoke
a model or provider.

The focused harness checks statistics, unsafe arguments, cleanup after failure,
exact-v10 seed totals, deliberately perturbed correctness oracles, and a
smallest-dataset integration through the real HTTP, timer SSE, preview,
projection, and `SubprocessJsonRpcAdapter` paths:

```bash
corepack pnpm --filter @jobctrl/api benchmark:local-scale:test
```

The exact-v10 and production-path integration cases require `uv`. They are
skipped when `uv` is unavailable so ordinary TypeScript CI can still test the
runtime-independent harness contracts.

## Method and proposed budgets

The deterministic seed is `jobctrl-local-scale-v1`. Each base dataset has 100,
1,000, or 10,000 jobs, three events per job (`discover`, `enrich`, and `score`),
a 1 KiB job description, scores from 0 through 10, one 256 KiB PDF preview, and
one 128 KiB HTML preview. Later scenarios add a fixed 50-event projection
batch, workflow lifecycle events, SSE batches, and bounded sustained writes.
Every dataset gets a separate temporary database and artifact directory.

Warm HTTP, preview, and RPC results use two warmups followed by seven retained
samples. The sustained scenario runs for at least 1.5 seconds and seven
iterations, with a 100-iteration cap. Each iteration writes 10 events, refreshes
a worker heartbeat, requests a free-text plus in-memory-sort job page, and reads
pipeline operations while a production SSE connection is open. Raw samples and
all correctness fields are in the sanitized repository artifact at
`docs/benchmarks/local-scale-baseline.json`.

These are proposed reference targets for diagnosis. They are not adopted SLOs
or CI gates:

| Scenario | Proposed target | Rationale |
| --- | ---: | --- |
| Warm list, search, in-memory sort, preview, or reused RPC p95 | 250 ms | Conservative local interactive response target |
| Settled projection no-op | 50 ms | Keep a watermark check small relative to an interactive request |
| Fixed 50-event foreground projection pass | 100 ms | Bound work before the background drain |
| One 1,000-event SSE batch visible | 600 ms | Two production 250 ms polls plus 100 ms delivery allowance |
| Fully drained cold projection: 100 / 1,000 / 10,000 jobs | 2 s / 8 s / 45 s | Separate one-time rebuild cost from warm requests with local-hardware allowance |
| Cold Python RPC startup | 10 s | Include `uv`, Python imports, and dispatcher startup |
| Sustained Node RSS / heap peak growth | 128 MiB / 64 MiB | Diagnostic bounds for this bounded workload, not long-horizon guarantees |

## Measured baseline

This baseline measured commit `5c56c5f67d7529f1cd35dc1e5aa257278f2ba7db`
on 2026-09-22. The checkout also contained an unrelated two-line change in
`workers/automation/uv.lock`; the report records and excludes it from the
candidate. Schema version was 10. The host was macOS 25.6.0 on arm64, Apple M4
Pro with 12 logical CPUs and 24 GiB memory, using Node v22.21.1, Python 3.14.4,
and SQLite 3.53.0.

Four other issue tasks were active on the host. The run had no CPU pinning or
isolated reference hardware, so it is a local baseline with background-load
contention. Keep the raw samples when comparing another run, and do not tighten
the proposed budgets from these measurements.

Projection correctness required the expected row count and an operations
watermark equal to the maximum event ID after convergence.

| Jobs | Cold foreground | Fully drained | Settled no-op | 50-event foreground | Rows / watermark |
| ---: | ---: | ---: | ---: | ---: | --- |
| 100 | 34.059 ms | 34.123 ms | 1.041 ms | 13.552 ms | 100 / 352 = 352 |
| 1,000 | 277.375 ms | 495.840 ms | 4.144 ms | 22.678 ms | 1,000 / 3,052 = 3,052 |
| 10,000 | 2,812.652 ms | 9,633.235 ms | 49.785 ms | **149.441 ms** | 10,000 / 30,052 = 30,052 |

HTTP responses returned the expected totals, the deterministic newest job for
the ordinary SQL-paginated list, exact free-text selectivity of 10%, and an
ascending production source sort key for the in-memory path.

| Jobs | Scenario | p50 | p95 | max |
| ---: | --- | ---: | ---: | ---: |
| 100 | Ordinary list | 8.373 ms | 9.236 ms | 9.236 ms |
| 100 | Free-text search | 10.042 ms | 11.069 ms | 11.069 ms |
| 100 | In-memory source sort | 10.107 ms | 10.544 ms | 10.544 ms |
| 1,000 | Ordinary list | 12.012 ms | 13.685 ms | 13.685 ms |
| 1,000 | Free-text search | 66.051 ms | 67.571 ms | 67.571 ms |
| 1,000 | In-memory source sort | 69.697 ms | 70.682 ms | 70.682 ms |
| 10,000 | Ordinary list | 75.628 ms | 76.026 ms | 76.026 ms |
| 10,000 | Free-text search | 670.362 ms | **682.057 ms** | 682.057 ms |
| 10,000 | In-memory source sort | 690.601 ms | **709.563 ms** | 709.563 ms |

The 10,000-job search and in-memory sort exceed the proposed warm p95 target,
as expected for the current materialize/filter/sort implementation. No
optimization is included in this baseline.

The real SSE route used its production 250 ms timer and 1,000-event tenant
batch. Idle observations lasted 550 ms and delivered zero domain events. Burst
and replay counts and numeric event ordering were exact for one subscriber and
four concurrent subscribers.

| Jobs | Idle Node CPU | One subscriber | Replay | Four subscribers | Total Node CPU |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 3.296 ms | 207.452 ms | 233.240 ms | 263.691 ms | 210.602 ms |
| 1,000 | 1.184 ms | 208.122 ms | 236.652 ms | 241.668 ms | 125.501 ms |
| 10,000 | 1.240 ms | 203.375 ms | 241.069 ms | 252.552 ms | 129.781 ms |

Preview responses came from the production PDF and HTML routes. Every sample
had the fixed byte count and SHA-256 digest: PDF
`17cd1e5bbcd90fe8fcb8bd05cfd4d403f69cda0fb8e06da85573c1ef0ae50ef0`
(262,144 bytes) and HTML
`d7f5febbf7b896b40f92fc7014da0428f56636964b174f244c5ee854b3a2d350`
(131,072 bytes).

| Jobs | Preview | p50 | p95 | max |
| ---: | --- | ---: | ---: | ---: |
| 100 | PDF | 4.078 ms | 4.336 ms | 4.336 ms |
| 100 | HTML | 3.553 ms | 3.761 ms | 3.761 ms |
| 1,000 | PDF | 7.771 ms | 7.932 ms | 7.932 ms |
| 1,000 | HTML | 7.420 ms | 7.599 ms | 7.599 ms |
| 10,000 | PDF | 54.731 ms | 56.988 ms | 56.988 ms |
| 10,000 | HTML | 53.683 ms | 55.516 ms | 55.516 ms |

RPC measurements used the real TypeScript `SubprocessJsonRpcAdapter`, locked
`uv` runtime, production Python `jobctrl rpc` dispatcher, and read-only
`provider_models` response. A single adapter instance was reused for warm
calls.

| Jobs | Cold startup | Warm p50 | Warm p95 | Warm max | Descendant RSS / CPU point sample |
| ---: | ---: | ---: | ---: | ---: | --- |
| 100 | 581.015 ms | 0.076 ms | 0.145 ms | 0.145 ms | 169,574,400 bytes / 69.5% |
| 1,000 | 582.878 ms | 0.073 ms | 0.094 ms | 0.094 ms | 175,112,192 bytes / 75.8% |
| 10,000 | 1,877.157 ms | 0.097 ms | 0.142 ms | 0.142 ms | 206,651,392 bytes / 99.9% |

The RPC resource scope is recursive descendants of the benchmark Node process
while the adapter is warm (`esbuild`, `uv`, and Python), excluding the Node
parent and `ps` sampler. The CPU value is a point-in-time `ps` observation, not
integrated CPU time.

The sustained workload preserved a production-visible `DiscoverWorkflow` in
`in_progress`, a fresh worker heartbeat, active `score_job` duration samples,
queue backlog 3, and two pipeline lifecycle events. Every written event arrived
over SSE. Node resource growth is scoped to the benchmark PID; peaks were
sampled once per workload iteration and end deltas after SSE convergence.

| Jobs | Duration / iterations / writes | Read p50 / p95 / max | Operations p50 / p95 / max | RSS / heap peak growth | Node CPU |
| ---: | --- | --- | --- | --- | ---: |
| 100 | 1,734.894 ms / 73 / 730 | 10.521 / 12.152 / 24.419 ms | 6.205 / 7.307 / 21.288 ms | 6,094,848 / 6,020,256 bytes | 1,587.830 ms |
| 1,000 | 1,550.904 ms / 18 / 180 | 72.977 / 89.492 / 89.492 ms | 6.479 / 37.976 / 37.976 ms | 55,394,304 / 60,184,688 bytes | 1,615.576 ms |
| 10,000 | 5,685.383 ms / 7 / 70 | 742.965 / 879.840 / 879.840 ms | 6.690 / 294.456 / 294.456 ms | 688,128 / **214,275,376 bytes** | 5,899.976 ms |

Database sizes after all scenarios were 10,306,216, 29,011,192, and
251,633,216 bytes. Artifact bytes were fixed at 393,216 for each dataset. The
overall benchmark Node peak RSS was 253,820,928, 536,379,392, and 885,882,880
bytes respectively; these absolute peaks include sequential-process carryover
and are reported separately from per-scenario growth.

The current exact-v10 global `llm_spend` totals stayed at zero input tokens,
zero output tokens, and zero estimated USD, and provider call count was zero.
The RPC dispatcher entered its instrumented path, but export was disabled. No
LLM method ran, so no LLM span token attributes or provider usage observations
exist for this benchmark. Zero spend does not establish complete usage
telemetry for unrelated workflows. Future per-lane accounting is separate
work; this baseline does not claim that lane state exists.

The 10,000-job run exceeded four proposed references: the 50-event foreground
projection pass (149.441 ms versus 100 ms), free-text search p95 (682.057 ms
versus 250 ms), in-memory sort p95 (709.563 ms versus 250 ms), and sustained
heap peak growth (214,275,376 bytes versus 67,108,864 bytes). All correctness
oracles passed. The measured evidence supports retaining these as visible
baseline failures without a speculative optimization.
