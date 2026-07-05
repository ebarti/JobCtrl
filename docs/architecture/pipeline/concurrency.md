# Concurrency & Fan-out

Where parallelism actually lives in the pipeline, what bounds it, and which
knobs are real. The short version: a single Python worker executes every
activity, its slot count is the only Temporal (the workflow engine) concurrency
control, and workflows fan out for isolation rather than for parallel speed-up.

**Read this if** you are tuning worker capacity, wondering why two stages are not
running in parallel, or hunting a throughput bottleneck.

```mermaid
flowchart LR
    CLI["CLI / API / schedule"] -->|start workflows| TQ["Task queue jobhunter-default"]
    TQ --> W["Python worker process"]
    subgraph W2["Worker capacity"]
        SLOTS["Activity slots: JOBHUNTER_MAX_CONCURRENT_ACTIVITIES (default 4)"]
        EXEC["ThreadPoolExecutor: slots + 2 threads"]
    end
    W --- W2
    W --> D["DiscoverWorkflow: per-family activities, sequential"]
    W --> P["JobPipelineWorkflow: stages in order, child workflows for discover / apply"]
    W --> A["ApplyWorkflow: single-flight per job id"]
    BUDGET["check_spend_budget preflight"] -.->|blocks over-budget starts| D & P & A

    classDef py fill:#d1fae5,stroke:#059669,color:#064e3b
    classDef infra fill:#fef3c7,stroke:#d97706,color:#78350f
    class CLI,W,SLOTS,EXEC,D,P,A,BUDGET py
    class TQ infra
```

## The Worker's Capacity Model

A single long-lived worker process (`jobhunter worker`) polls the
`jobhunter-default` task queue and executes every activity. Two numbers define
its capacity, both fixed at worker startup in
`infrastructure/temporal/worker.py`:

- **Activity slots** — `JOBHUNTER_MAX_CONCURRENT_ACTIVITIES` (default `4`):
  the maximum number of Temporal activities running at once, across all
  workflows.
- **Executor threads** — a worker-owned `ThreadPoolExecutor` sized
  `slots + 2`, so blocking stage work never spills into the process default
  executor.

The worker heartbeat records both values, `GET /v1/health` returns them, and
the Settings page shows them, so the running capacity is always inspectable.
Changing capacity means setting the environment variable and restarting the
worker — it is process configuration, not a runtime setting.

Two knobs that look like Temporal concurrency but are not:

- The Pipelines page's **Workers** field flows into the discovery payload and
  controls per-source scraping parallelism inside a source activity (the
  JobSpy worker count), not Temporal activity slots.
- Search-combination execution inside one source family is sequential today
  (a plain loop in `jobspy.py`); parallelising it is a filed
  [backlog item](../../backlog.md), not current behavior.

## Where Fan-out Happens (And Why)

- **DiscoverWorkflow** plans sources once (`plan_discovery_sources`), then runs
  one `discovery_source_family` activity **per source family in a sequential
  loop**. This is deliberate isolation, not parallelism: each family gets its
  own activity-level timeout, heartbeat, and retry policy, and a family
  failure is recorded (`families_failed`) while the loop continues to the next
  family. Enrichment and the preparation fan-out run as follow-up activities
  after the families finish.
- **JobPipelineWorkflow** executes the selected stages in pipeline order and
  delegates `discover` and `apply` to child workflows, so the risky surfaces
  keep their own workflow identity, history, and retry policy.
- **ApplyWorkflow** is single-flight per job: the workflow id
  `apply-{tenant}-{jobKey}` plus `USE_EXISTING` and a one-attempt live retry
  policy make a duplicate submission structurally impossible rather than
  merely unlikely.
- Concurrent workflows (a discovery run, a scoring batch, an apply) share the
  worker's activity slots; Temporal queues whatever exceeds them.

## What Bounds Throughput

| Bound | Mechanism | Where |
| --- | --- | --- |
| Activity slots | `JOBHUNTER_MAX_CONCURRENT_ACTIVITIES`, executor `slots + 2` | `infrastructure/temporal/worker.py` |
| LLM spend | `check_spend_budget` preflight stops spendful workflows at the daily ceiling | [Spend Ceiling](operations.md#spend-ceiling) |
| Retries | per-activity retry policies from the error taxonomy | [Envelope & Activities](envelope.md) |
| Worker readiness | worker-backed API actions return 503 until a healthy heartbeat exists | [Runtime Boundaries](../runtime.md) |
| Apply single-flight | per-job workflow id + submit-intent checkpoint | [Stage Walkthrough](stages.md#apply) |

Data-flow context — where each stage persists and how results reach the UI —
lives in [Operations & Events](operations.md).
