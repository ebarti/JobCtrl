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

Use `--background-load-note` to preserve a run-specific concurrency observation.
A known dirty file can be recorded only by supplying all three
`--dirty-exclusion-*` arguments: repository-relative path, verified content
SHA-256, and an explicit reason. The runner rejects partial or mismatched
exclusions.

The command refuses to overwrite its output. The RPC subprocess receives a
minimal allowlisted environment plus an isolated home and Codex, Claude, AWS,
Google, and Azure config paths. AWS metadata and Langfuse export are disabled,
and unexpected outbound proxy traffic goes to an unreachable loopback port.
Before the read-only `provider_models` call, the production `provider_status`
method must prove that all providers are non-ready. The returned model catalog
must pass the production schema with no ready provider and no models. Any
failure stops the run before provider model discovery can execute.

The focused harness checks statistics, unsafe arguments, cleanup after failure,
exact-v10 seed totals, deliberately perturbed correctness oracles, an ambient
Bedrock/AWS/provider-credential counterfactual, and a
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
samples. Percentiles use nearest rank, so p95 selects the maximum when only
seven samples are retained. These are exploratory, tail-sample-limited local
observations rather than stable population estimates.

The sustained scenario runs for at least 1.5 seconds and seven iterations, with
a 100-iteration cap. Each iteration directly writes 10 synthetic events,
updates a seeded heartbeat, requests a free-text plus in-memory-sort job page,
and reads seeded pipeline-operation records while a production SSE connection
is open. It is not a live Temporal worker, provider workload, or endurance
benchmark. Raw samples and all correctness fields are in the sanitized
repository artifact at `docs/benchmarks/local-scale-baseline.json`.

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

This baseline measured commit `8c80b31b584c7ef92b80f92ea9e496c968a8269a`
on 2026-09-22. The checkout also contained an unrelated two-line change in
`workers/automation/uv.lock`. The run received an explicit exclusion path,
content SHA-256 `4eaf563541a57070c8e1b661d34aad441d419ef8811dbd02abdc64b267148a67`,
and note; it verified the content hash, exact porcelain status, two-addition
numstat, and diff identity before recording the exclusion. Generic runs do not
infer that a dirty path is unrelated. Schema version was 10. The host was macOS
25.6.0 on arm64, Apple M4 Pro with 12 logical CPUs and 24 GiB memory, using Node
v22.21.1, Python 3.14.4, and SQLite 3.53.0.

The invocation explicitly annotated that four other issue tasks were active on
the host. The benchmark did not independently measure concurrent activity and
had no CPU pinning or isolated reference hardware, so it is a local baseline
with background-load contention. Generic future runs report concurrent load as
unmeasured unless the operator supplies an annotation. Keep the raw samples
when comparing another run, and do not tighten the proposed budgets from these
measurements.

Projection correctness required the expected row count and an operations
watermark equal to the maximum event ID after convergence.

| Jobs | Cold foreground | Fully drained | Settled no-op | 50-event foreground | Rows / watermark |
| ---: | ---: | ---: | ---: | ---: | --- |
| 100 | 34.626 ms | 34.714 ms | 1.072 ms | 14.493 ms | 100 / 352 = 352 |
| 1,000 | 290.549 ms | 516.594 ms | 4.335 ms | 23.306 ms | 1,000 / 3,052 = 3,052 |
| 10,000 | 2,833.645 ms | 9,739.466 ms | **50.123 ms** | **147.061 ms** | 10,000 / 30,052 = 30,052 |

HTTP responses returned the expected totals, the deterministic newest job for
the ordinary SQL-paginated list, exact free-text selectivity of 10%, and an
ascending production source sort key for the in-memory path.

| Jobs | Scenario | p50 | p95 | max |
| ---: | --- | ---: | ---: | ---: |
| 100 | Ordinary list | 8.238 ms | 9.061 ms | 9.061 ms |
| 100 | Free-text search | 9.802 ms | 10.149 ms | 10.149 ms |
| 100 | In-memory source sort | 10.315 ms | 10.928 ms | 10.928 ms |
| 1,000 | Ordinary list | 12.157 ms | 13.086 ms | 13.086 ms |
| 1,000 | Free-text search | 68.139 ms | 69.205 ms | 69.205 ms |
| 1,000 | In-memory source sort | 71.768 ms | 72.956 ms | 72.956 ms |
| 10,000 | Ordinary list | 76.373 ms | 76.969 ms | 76.969 ms |
| 10,000 | Free-text search | 673.366 ms | **689.119 ms** | 689.119 ms |
| 10,000 | In-memory source sort | 693.720 ms | **707.482 ms** | 707.482 ms |

The 10,000-job search and in-memory sort exceed the proposed warm p95 target,
as expected for the current materialize/filter/sort implementation. No
optimization is included in this baseline.

The real SSE route used its production 250 ms timer and 1,000-event tenant
batch. Idle observations lasted 550 ms and delivered zero domain events. Burst
and replay counts and numeric event ordering were exact for one subscriber and
four concurrent subscribers. This validates the server transport, timer, event
ID, and count boundary with benchmark-only event types. It does not validate
frontend event-registry membership or decoded-envelope acceptance.

| Jobs | Idle Node CPU | One subscriber | Replay | Four subscribers | Total Node CPU |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 3.223 ms | 209.890 ms | 233.392 ms | 259.817 ms | 177.614 ms |
| 1,000 | 0.931 ms | 205.573 ms | 240.149 ms | 253.531 ms | 140.888 ms |
| 10,000 | 1.788 ms | 209.294 ms | 234.996 ms | 257.088 ms | 135.086 ms |

Preview responses came from the production PDF and HTML routes. Every sample
had the fixed byte count and SHA-256 digest: PDF
`17cd1e5bbcd90fe8fcb8bd05cfd4d403f69cda0fb8e06da85573c1ef0ae50ef0`
(262,144 bytes) and HTML
`d7f5febbf7b896b40f92fc7014da0428f56636964b174f244c5ee854b3a2d350`
(131,072 bytes).

| Jobs | Preview | p50 | p95 | max |
| ---: | --- | ---: | ---: | ---: |
| 100 | PDF | 3.963 ms | 4.927 ms | 4.927 ms |
| 100 | HTML | 3.722 ms | 3.895 ms | 3.895 ms |
| 1,000 | PDF | 7.851 ms | 8.389 ms | 8.389 ms |
| 1,000 | HTML | 7.622 ms | 7.758 ms | 7.758 ms |
| 10,000 | PDF | 54.301 ms | 55.262 ms | 55.262 ms |
| 10,000 | HTML | 54.112 ms | 55.111 ms | 55.111 ms |

RPC measurements used the real TypeScript `SubprocessJsonRpcAdapter`, locked
`uv` runtime, production Python `jobctrl rpc` dispatcher, and read-only
`provider_status` and `provider_models` responses. Cold startup includes the
status preflight. All three statuses were unconfigured and non-ready before the
catalog call, and every catalog envelope passed the production schema with zero
models. A single adapter instance was reused for warm catalog calls.

| Jobs | Cold startup | Warm p50 | Warm p95 | Warm max | Descendant RSS / CPU point sample |
| ---: | ---: | ---: | ---: | ---: | --- |
| 100 | 498.749 ms | 0.110 ms | 0.175 ms | 0.175 ms | 170,737,664 bytes / 72.4% |
| 1,000 | 587.419 ms | 0.065 ms | 0.091 ms | 0.091 ms | 176,209,920 bytes / 75.3% |
| 10,000 | 1,839.813 ms | 0.070 ms | 0.098 ms | 0.098 ms | 207,208,448 bytes / 96.1% |

The RPC resource scope is recursive descendants of the benchmark Node process
while the adapter is warm (`esbuild`, `uv`, and Python), excluding the Node
parent and `ps` sampler. The CPU value is a point-in-time `ps` observation, not
integrated CPU time.

The sustained workload seeded a `DiscoverWorkflow` record in `in_progress`, a
worker-heartbeat record, `score_job` duration samples, queue backlog 3, and two
pipeline lifecycle records. It directly refreshed the synthetic heartbeat and
wrote synthetic events; no Temporal worker or provider ran. Every written event
arrived over SSE. Node resource growth is scoped to the benchmark PID; peaks
were sampled once per workload iteration and end deltas after SSE convergence.
Sampling between iterations can miss short-lived spikes.

| Jobs | Duration / iterations / writes | Read p50 / p95 / max | Operations p50 / p95 / max | RSS / heap peak growth | Node CPU |
| ---: | --- | --- | --- | --- | ---: |
| 100 | 1,745.274 ms / 73 / 730 | 10.663 / 11.500 / 24.073 ms | 6.234 / 6.838 / 21.039 ms | 5,980,160 / 5,999,096 bytes | 1,601.493 ms |
| 1,000 | 1,551.300 ms / 18 / 180 | 72.927 / 97.806 / 97.806 ms | 6.385 / 35.962 / 35.962 ms | 36,814,848 / 44,614,552 bytes | 1,576.446 ms |
| 10,000 | 5,755.515 ms / 7 / 70 | 750.845 / 894.215 / 894.215 ms | 6.681 / 300.844 / 300.844 ms | 39,288,832 / **194,176,016 bytes** | 5,996.898 ms |

Database sizes after all scenarios were 10,306,216, 29,011,192, and
251,633,216 bytes. Artifact bytes were fixed at 393,216 for each dataset. The
overall benchmark Node peak RSS was 254,787,584, 515,784,704, and 918,470,656
bytes respectively; these absolute peaks include sequential-process carryover
and are reported separately from per-scenario growth.

The current exact-v10 global `llm_spend` totals stayed at zero input tokens,
zero output tokens, and zero estimated USD, and provider call count was zero.
The RPC dispatcher entered its instrumented path, but export was disabled. No
LLM method ran, so no LLM span token attributes or provider usage observations
exist for this benchmark. Zero spend does not establish complete usage
telemetry for unrelated workflows. Future per-lane accounting is separate
work; this baseline does not claim that lane state exists.

The 10,000-job run exceeded five proposed references: settled projection no-op
(50.123 ms versus 50 ms), the 50-event foreground projection pass (147.061 ms
versus 100 ms), free-text search p95 (689.119 ms versus 250 ms), in-memory sort
p95 (707.482 ms versus 250 ms), and sustained heap peak growth (194,176,016
bytes versus 67,108,864 bytes). All correctness oracles passed. The measured
evidence supports retaining these as visible baseline failures without a
speculative optimization.
