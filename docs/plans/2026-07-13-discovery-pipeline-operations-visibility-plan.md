# Discovery Pipeline Operations Visibility Plan

- **Date:** 2026-07-13
- **Status:** Active — implementation and canonical documentation are complete
  on the open cumulative stack; cumulative Tier 3 QA and independent gates are
  in progress.
- **Anchors:** Current behavior and file ownership verified against
  `main @ 47cfba58`. Re-verify every path and contract against the base of each
  implementation PR.
- **UI coordination:** The operational facts, information priority, typed
  states, and accessibility requirements in this plan are stable. Exact visual
  containers, component names, spacing, and responsive composition must follow
  the app UI redesign current when P3 starts.
- **Goal:** From the Pipelines page, a user can tell what a Discover execution is
  doing, how much work is waiting at each step, what is processing, which
  concurrency limit applies, whether telemetry is fresh, and when the current
  execution is likely to finish.

### Delivery status — 2026-07-15

- Execution lineage, runtime telemetry, the operations read model, and the
  Rhea Pipelines workspace are published as stacked PRs #459–#462.
- The implemented workspace preserves the plan's stable semantic contract
  while using the current shadcn/Base UI system rather than the pre-redesign
  composition names.
- The accepted pipeline-operations decision made one explicit semantic change
  to the original draft: both execution-owned cohorts participate in the
  delivered phase. Current-execution and execution-sweep counts remain
  separate, but unresolved swept work can keep the overall execution in
  `draining`. Only global work outside the selected execution is excluded from
  its phase. This supersedes the earlier single-cohort wording below.
- Canonical documentation and the synthetic 32-image screenshot gallery are
  complete. The implementation remains active rather than archived because the
  stack is not merged and cumulative QA, reviewer, and QA-agent gates are not
  yet complete.

---

## 0. Outcome

Replace the single ambiguous line:

> Discover 50% complete (3/6): Workday scraper complete.

with an operations view that separates source-family progress from the
downstream preparation drain.

The default summary should read like this when three of four source families
have completed and scoring is backed up:

```text
Discovering sources · 18 jobs found · 7 waiting · 4 processing
Estimated completion: 12–19 min · low confidence · updated 8s ago

Source families                3 / 4 complete (75%)
Terminal reconciliation       waiting
Shared Temporal activity pool  4 / 4 slots busy · 1 worker process
Temporal activity queue        ≈12 tasks · oldest ≈2m
```

The detailed view then exposes one row per operational step:

| Step            | Current execution | Existing backlog | Processing | Capacity                           | Estimate          |
| --------------- | ----------------- | ---------------- | ---------- | ---------------------------------- | ----------------- |
| Plan sources    | complete          | —                | 0          | workflow control                   | complete          |
| Crawl sources   | 3/4 families      | —                | Workday    | 1 shared slot; 10 internal fetches | 4–7m              |
| Enrich          | 2 waiting         | 3 waiting        | 1 job      | shared 4-slot pool                 | 2–4m              |
| Score           | 5 waiting         | 8 waiting        | 2 jobs     | shared 4-slot pool                 | 7–12m             |
| Tailor          | 0 eligible        | 4 waiting        | 1 job      | shared 4-slot pool                 | calibrating       |
| Cover letter    | 0 eligible        | 1 waiting        | 0          | shared 4-slot pool                 | waiting on tailor |
| Render PDF      | 0 eligible        | 0                | 0          | no separate durable queue          | —                 |
| Ready for Apply | 4 ready           | —                | —          | derived outcome                    | —                 |

The values above are illustrative, not a new fixed layout contract. The
implementation must preserve the distinctions they demonstrate:

1. source progress is not product completion;
2. current-execution work is not historical/global backlog;
3. the Pipelines form's internal activity concurrency is not Temporal worker
   capacity;
4. domain backlog counts are not the same unit as Temporal task-queue depth;
5. an estimate is a range with freshness and confidence, never an unexplained
   exact timestamp.

The ongoing app redesign may express this hierarchy as cards, a compact
stepper, an operations table, an expandable drawer, or a responsive combination
of them. It must not collapse the facts back into one blended percentage or
hide backlog, capacity, freshness, and ETA behind visual simplification.

---

## 1. Product invariant

For every active Discover execution, the Pipelines surface must prove all of
the following from explicit sources of truth:

1. Which orchestration phase and source family are active.
2. How many jobs in the current execution are waiting, processing, terminal,
   blocked, and failed at each required preparation stage.
3. How much older work exists outside the current execution.
4. How many Temporal worker processes and shared activity slots are configured,
   busy, available, and stale.
5. Which separate concurrency control applies to each step.
6. Which bounded, safe work items are currently processing and for how long.
7. Whether Temporal's infrastructure backlog is growing or draining.
8. A completion range with basis, sample size, confidence, and observation time,
   or an explicit reason an estimate cannot yet be made.
9. Whether the source crawl is complete while preparation is still draining.
10. Whether completion contains blocked, failed, skipped, or exhausted work that
    needs attention.

For this surface, **Discover complete** means that the source crawl has reached
a terminal state and every required step for both execution-owned cohorts has
reached an accounted-for terminal state. A completed source workflow with live
current-execution or execution-sweep preparation workflows is **draining**, not
complete.

Pre-existing work swept at the beginning of a Discover workflow is visible as
**Execution sweep / Existing backlog**. It does not enter the current-execution
cohort's numerator or denominator and is never blended into those counts. The
accepted implementation treats it as work deliberately adopted by the selected
execution, so unresolved swept work can keep the overall execution phase in
`draining`. It also competes for the same shared activity slots and therefore
influences ETA as external contention. Global backlog outside the selected
execution remains separate and cannot prevent that execution from completing.

---

## 2. Root cause

### 2.1 Current behavior

The current Discover progress denominator is the number of selected source
families plus two terminal reconciliation steps. The per-family enrichment and
preparation fan-outs are deliberately progress-silent so the existing bar stays
monotonic. Meanwhile, each job continues through its own
`JobPreparationWorkflow` after source discovery emits its terminal result.

That design made score-as-you-discover responsive, but the Pipelines UI still
labels the crawl/reconciliation spine as overall **Discover completion**. The
display therefore reaches 50% or 100% without answering why jobs visible on the
Jobs page are waiting for scores.

The form also labels its per-source scraping parallelism as **Workers**. That
value can be 10 while the Python Temporal worker has the default four shared
activity slots. Every discovery, enrichment, scoring, tailoring, material, and
apply activity competes for that same pool, and Temporal queues the excess.

### 2.2 Five whys

1. **Why is the status confusing?** Its numerator and denominator exclude the
   downstream per-job preparation backlog.
2. **Why can the UI call it Discover completion?** `StageTriggerPanel` formats a
   scope-less `PipelineProgressSummary` as a whole-stage percentage.
3. **Why can it not explain the queued scores?** The Operations API has no
   execution-correlated stage backlog, active-slot inventory, task-queue
   statistics, or ETA contract.
4. **Why does the problem become visible during a large run?** Streaming
   discovery can produce jobs faster than the shared activity pool drains
   enrichment and preparation; the UI shows only the producer's control-flow
   spine.
5. **Why can current tables not reconstruct the truth later?**
   `job_source_observations.run_id` is updated when the same job is observed
   again, and `JobPreparationWorkflow` does not retain the originating Discover
   execution. Current-run membership is therefore not durable.

### 2.3 Fix layer

- **Proximal symptom:** the single line and progress bar in
  `StageTriggerPanel`.
- **Failure mechanism:** product completion is inferred from crawl-spine
  progress.
- **Trigger:** producer/consumer imbalance while source results stream into
  independent root preparation workflows.
- **Root cause:** workflow lineage and the Operations read model do not expose
  run-scoped queue, capacity, active-work, and duration facts.
- **Correct fix:** persist lineage and step lifecycle in the Python
  worker/orchestration layer, observe the Temporal worker and task queue,
  aggregate an honest TypeScript API contract, then render it through the
  frontend Operations context.

Changing the wording or hiding the percentage alone is not a fix.

---

## 3. Ubiquitous language and ownership

The implementation must use these terms consistently in code, contracts, and
copy:

| Term                     | Meaning                                                                                                                                                                                                                                                             | Source of truth                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Discovery execution      | One Temporal execution of `DiscoverWorkflow`, identified by workflow ID plus Temporal run ID                                                                                                                                                                        | `Workflow*` events and `workflow_run_projections`         |
| Source run               | A source-family ingestion attempt; this is the existing `discovery_runs.run_id`, not the parent Discovery execution                                                                                                                                                 | `discovery_runs`                                          |
| Current-execution cohort | Jobs observed during one Discovery execution                                                                                                                                                                                                                        | new durable execution/job lineage                         |
| Existing backlog         | Work selected by the pre-run straggler sweep and not subsequently observed in the current execution                                                                                                                                                                 | new lineage with `cohort_kind = existing_backlog`         |
| Domain backlog           | Jobs whose canonical required stage state is non-terminal                                                                                                                                                                                                           | `job_stage_states` plus execution lineage                 |
| Infrastructure backlog   | Approximate Temporal workflow/activity tasks waiting on the shared task queue                                                                                                                                                                                       | Temporal `DescribeTaskQueue`; always labelled approximate |
| Shared activity capacity | Sum of configured activity slots across fresh worker processes on the task queue                                                                                                                                                                                    | worker runtime heartbeats                                 |
| Internal concurrency     | The current `workers` form/input value. It controls parallel source work and enrichment site batches inside a running activity; it does not add Temporal activity slots. The current per-job preparation path carries the value but processes one job per activity. | Discover workflow input and typed activity inputs         |
| Active work              | A currently executing, allowlisted pipeline activity observed by a fresh worker                                                                                                                                                                                     | worker activity snapshot                                  |
| Completion estimate      | A typed range or explicit non-estimate with basis, samples, confidence, and timestamp                                                                                                                                                                               | Operations estimator                                      |

`preparation_work_items` is not an authority for this feature. The active
Temporal-native path starts root `JobPreparationWorkflow` executions instead of
claiming that legacy local queue, so its queued/running counts would misreport
the system the user is actually waiting on.

---

## 4. Execution model the UI must expose

JobCtrl does not currently have a separately configured worker pool for every
stage. The UI must show that topology rather than inventing per-stage worker
counts.

| Step kind                         | Capacity model                                                                                                                                                                                                                    | Backlog model                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Plan/fan-out workflow control     | Temporal workflow code; it does not consume an activity slot while waiting                                                                                                                                                        | lifecycle only; no fabricated job queue                                                                                    |
| Source-family crawl               | one activity slot per running family, bounded by Discovery Runtime `max_parallel_families` (SQLite-backed, default `1`, safety-capped at `4` and by active `worker_activity_slots`); the form value controls internal source work | planned/running/terminal source families                                                                                   |
| Enrich                            | one shared activity slot per running enrichment pass; the form value controls parallel site batches inside that activity                                                                                                          | canonical enrich states plus scoped orchestration passes                                                                   |
| Per-job score, tailor, cover, PDF | one shared activity slot per running step; the current root preparation path processes one job per activity, so the form value does not create more Temporal slots                                                                | canonical stage states where available; preparation workflow requirements and active activity state for non-stage substeps |
| Ready for Apply                   | derived outcome, not a worker or queue                                                                                                                                                                                            | current cohort jobs whose required preparation is accounted for                                                            |

Every row therefore carries a typed capacity description such as
`shared_activity_pool`, `source_internal_parallelism`, `workflow_control`, or
`derived_outcome`. A blank number must never imply zero workers.

The top-level capacity card owns the actual counts:

- worker processes seen and fresh;
- configured shared activity slots;
- active and available slots;
- activity executor threads, shown only as implementation detail in an
  expandable diagnostics section;
- workflow and activity pollers;
- approximate task counts, oldest task age, add rate, and dispatch rate;
- observation time and stale threshold.

---

## 5. Domain and persistence changes

### 5.1 Durable execution identity

Capture `workflow.info().workflow_id` and `workflow.info().run_id` once in
`DiscoverWorkflow`. Pass an explicit, serializable `DiscoveryExecutionRef`
through source, enrichment, preparation-fan-out, and per-job preparation
inputs:

```text
DiscoveryExecutionRef
  tenant_id
  workflow_id
  temporal_run_id
```

Do not reuse the source-specific `discovery_runs.run_id` for this identity.

### 5.2 Current-execution cohort

Add an indexed `discovery_execution_jobs` table owned by Discovery:

```text
tenant_id
discover_workflow_id
discover_run_id
job_url
cohort_kind              observed_this_run | existing_backlog
source_family            nullable
source_run_id             nullable
preparation_workflow_id   nullable
work_plan_state           pending | planned | not_eligible | failed
required_steps_json       nullable validated list of score/tailor/cover/pdf
work_plan_reason          nullable safe code
linked_at
```

The key is `(tenant_id, discover_workflow_id, discover_run_id, job_url)`; a job
can contribute to exactly one cohort bucket per execution. Identity and
first-link fields are immutable within an execution, while scheduling fields
may be filled idempotently when a preparation workflow is selected. A later
Discover execution inserts a new row instead of rewriting history.

The upsert rule is ordered: `observed_this_run` wins over `existing_backlog`.
If the pre-run sweep links an old pending job and a source later observes that
same job, atomically promote the one row to `observed_this_run`; never insert a
second row or count it in both backlog/ETA scopes. Promotion never runs in the
opposite direction.

`required_steps_json = NULL` means the work plan has not been decided; it never
means that no work is required. Completion requires either a planned workflow
whose required steps are accounted for or an explicit `not_eligible` decision.
A pending/failed work plan keeps the execution draining or completes it with
issues according to the terminal workflow outcome.

Populate `observed_this_run` at the common source-observation persistence
boundary, not in source-specific UI or API code. Populate `existing_backlog`
when the pre-run preparation sweep selects its targets. Propagate the execution
reference and cohort kind into `JobPreparationInput` and its safe input summary.

This table records membership and required work only. It does not duplicate
stage status: current state remains owned by `job_stage_states`, workflow state
by `workflow_run_projections`, and artifacts by the Materials projections.

### 5.3 Orchestration-step lifecycle

Add typed `PipelineStepQueued`, `PipelineStepStarted`,
`PipelineStepCompleted`, and `PipelineStepFailed` events for the steps that do
not have a per-job `job_stage_states` row: source planning, each source family,
every streaming and terminal enrichment/fan-out pass, the pre-existing sweep,
and PDF rendering. Give repeated passes an explicit scope key such as
`family:<family>`, `terminal`, or `existing_backlog` so they cannot overwrite
one another.

Project them into `pipeline_step_projections`, keyed by execution, step kind,
and item key. Store state, attempt, timestamps, duration, safe error code, and a
bounded safe detail. Do not store arbitrary activity inputs or provider output.

Per-job enrich/score/tailor/cover counts continue to come from canonical stage
state. The new projection fills orchestration visibility gaps; it does not
become a second job-stage state machine.

### 5.4 Worker and task-queue observation

Extend worker heartbeats so each fresh process reports:

- worker ID, task queue, configured activity slots, executor threads, and
  heartbeat time;
- an exact `active_activity_count` and exact bounded-cardinality counts by
  allowlisted activity type;
- up to 20 active-activity details with activity type, execution/workflow
  reference, allowlisted operational item reference, attempt, and start time,
  plus `active_details_truncated` and the total detail count;
- task-queue statistics sampled from Temporal's `DescribeTaskQueue` service API.

Use a worker-side activity interceptor or shared wrapper to register start and
terminal transitions in a concurrency-safe in-memory inventory. Read only an
explicit `OperationalActivityRef`; never serialize arbitrary activity payloads.
The API resolves opaque local references to title/company from existing local
projections. Raw URLs, descriptions, resume content, prompts, provider output,
artifact paths, and secrets never enter runtime heartbeats or exported spans.

The Temporal dev server or an older server may not support every enhanced task
queue field. Model unsupported, unavailable, and stale states explicitly. A
failed queue-stat sample must not stop the worker heartbeat or the pipeline.

When more than one worker process exists, aggregate only fresh heartbeats for
the same tenant/task queue. The current latest-heartbeat-only read is not
sufficient for capacity totals. Sum per-worker configured slots and exact
active counts; merge the bounded detail lists only for display and preserve a
truncated flag. Never derive busy/free slots from the number of returned detail
rows. Select one freshest `DescribeTaskQueue` observation per task queue; every
worker observes the same queue, so adding those queue counts would multiply the
backlog.

---

## 6. Read model and API contract

Add `GET /v1/pipeline/operations`. With no query parameter it returns the most
recent active or draining Discover execution, falling back to the latest
terminal execution plus current global backlog/capacity. Version 1 does not
offer point-in-time historical reconstruction: mutable stage state and runtime
heartbeats cannot truthfully recreate an old queue snapshot. Workflow ID alone
is never treated as an execution identity because `discover-local` is reused.

The shared contract is `PipelineOperationsSnapshot`:

```ts
interface PipelineOperationsSnapshot {
  generatedAt: string;
  etaEstimatorVersion: string;
  freshness: OperationsFreshness;
  execution: DiscoveryExecutionSummary | null;
  capacity: PipelineCapacity;
  sourceFamilies: SourceFamilyProgress | null;
  reconciliation: DiscoveryReconciliationProgress | null;
  stages: PipelineOperationalStage[];
  activeItems: PipelineActiveItem[]; // bounded to 20, longest-running first
  overallEta: PipelineEta;
}
```

Required semantics:

- `execution.phase` is one of `discovering`, `draining`, `completed`,
  `completed_with_issues`, `failed`, or `canceled`.
- `sourceFamilies` counts only planned source families from the new scoped step
  projection. The current `families + 2` denominator remains available only as
  legacy orchestration diagnostics during compatibility migration; it is never
  labelled source crawl or used as overall completion.
- `reconciliation` reports terminal enrichment and preparation fan-out
  separately, so four completed families followed by two pending reconciliation
  steps reads **4/4 source families; reconciliation pending**, not **4/6 source
  crawl**.
- every operational stage contains separate `currentExecution` and
  `existingBacklog` count sets;
- counts distinguish `eligible`, `waiting`, `processing`, `succeeded`,
  `skipped`, `blocked`, `failed`, `exhausted`, and `canceled` where the owning
  source can prove them;
- a substep with no durable separate queue uses `backlog.kind = "not_separate"`
  instead of `waiting = 0`;
- `capacity.approximateTaskQueue` is explicitly approximate and keeps activity
  tasks separate from domain jobs;
- all snapshots carry observation timestamps and stale thresholds.

`PipelineEta` is a discriminated union:

```ts
type PipelineEta =
  | {
      status: "available";
      lowSeconds: number;
      highSeconds: number;
      confidence: "low" | "medium" | "high";
      basis: "source_rate" | "stage_throughput" | "cohort_throughput";
      sampleSize: number;
      asOf: string;
      caveat: string | null;
    }
  | {
      status: "calibrating";
      completedSamples: number;
      minimumSamples: number;
      asOf: string;
    }
  | {
      status: "paused";
      reason:
        | "worker_unavailable"
        | "budget_exceeded"
        | "blocked"
        | "no_dispatch";
      asOf: string;
    }
  | {
      status: "unavailable";
      reason: "no_work" | "telemetry_stale" | "unsupported" | "unknown_scope";
      asOf: string;
    };
```

Do not add these operational fields to `DashboardSummary`. That endpoint is
already broad and cached by unrelated views. A separate query key allows the
Pipelines page to refresh at the worker-heartbeat cadence without refetching the
whole dashboard.

The existing `PipelineProgressSummary` remains compatible for other consumers
during migration. `StageTriggerPanel` stops presenting it as overall Discover
completion once the new endpoint lands.

---

## 7. ETA policy

ETA is an operational estimate, not a promise. Version 1 must be simple enough
to explain from persisted evidence.

### 7.1 Source crawl

When the planned source-family total is known and at least two families have
completed, estimate the remaining crawl range from recent durations for the
same source family when available, falling back to the current execution's
elapsed family-completion rate. Terminal enrichment and fan-out have their own
step estimates. Keep source ETA separate from preparation drain ETA.

### 7.2 Per-stage drain

For enrich, score, tailor, and cover:

1. count only eligible, non-terminal jobs in the selected scope;
2. use successful terminal transitions from `job_stage_states.duration_ms` and
   `operational_attempt_metrics`;
3. measure existing-backlog active work, oldest age, and recent dispatch share
   as external contention on the same shared pool;
4. calculate low/high ranges from recent p50/p90 observed service time or
   completion throughput;
5. report the sample size and lower confidence when stages share a saturated
   pool or retries/provider throttling are present;
6. return `calibrating` until at least five comparable completions exist.

Existing-backlog jobs are not added to the current cohort's remaining-work
count, but unresolved execution-sweep work participates in the overall phase.
Its observed slot occupancy and queue-ahead effect must also reduce effective
throughput or widen the range. When queue ordering/contention cannot be bounded
from current telemetry, return `calibrating` or `unavailable` instead of an ETA
that assumes all slots belong to the current cohort.

The form's internal concurrency must never be used as preparation capacity.
Configured shared slots are context, not a claim that every slot is available
to one stage.

### 7.3 Overall completion

While sources are still producing jobs, the overall range is provisional and
must say **may increase as more jobs are found**. Once source membership closes,
estimate the current cohort's drain from its remaining required steps and
observed cohort/stage throughput after accounting for external shared-pool
contention. The high bound must include current retry and blocked-state
evidence; blocked work with no progress path produces `paused` rather than an
infinite or zero ETA.

Use a rolling window that is bounded by count and age so old provider/runtime
behavior does not dominate. Persist the estimator version and basis in the API
response so future calibration changes remain auditable.

No estimate is better than a fabricated estimate. The UI must render
`calibrating`, `paused`, `stale`, and `unavailable` as first-class states.

---

## 8. Frontend behavior

### 8.1 Page composition

Keep `PipelinesView` as a composer. Add context-owned components under
`apps/web/src/contexts/pipeline/`:

- `PipelineOperationsSummary` — phase, cohort counts, freshness, and overall
  ETA;
- `PipelineCapacityCard` — worker processes, shared slots, task queue, and
  observation age;
- `PipelineStageTable` — source and preparation rows with current/existing
  backlog and typed capacity semantics;
- `PipelineActiveWork` — expandable bounded list of current work;
- `SourceCrawlProgress` — the correctly named existing progress spine.

These names describe ownership and test boundaries, not a frozen visual tree.
Before P3 implementation, rebase on the latest landed UI redesign and map these
responsibilities onto its established shell, tokens, density, primitives, and
responsive patterns. Reuse that system; do not introduce a parallel visual
language specific to Pipelines.

Read through a new `usePipelineOperationsQuery` Operations hook. The view and
components never call the API client or query client directly.

### 8.2 Trigger form corrections

- Rename **Workers** to **Internal concurrency**.
- Add helper copy: **Parallel source work and enrichment site batches inside a
  running activity. Temporal worker capacity is shown below.**
- Preserve request payload and CLI compatibility; this is a label/contract
  clarification, not a breaking command change.
- Keep the action controls visible when the operations endpoint is unavailable;
  render an honest diagnostics error instead of disabling unrelated actions.

### 8.3 Realtime and refresh

Add hierarchical `pipelineOperationsKeys` in
`contexts/pipeline/queryKeys.ts` and re-export it through the Operations
query-key registry. Existing workflow, stage, scoring, materials, and discovery
events invalidate the selected execution snapshot through context handlers.

Heartbeat and task-queue changes may occur without a durable domain event, so
use a 15-second refetch interval while an execution is active and a slower
interval when idle. SSE remains the fast path; polling is the capacity/freshness
backstop. Refetches must not collapse expanded rows or move keyboard focus.

Only the concise overall phase line is a polite live region. Do not announce
every heartbeat, queue-count change, or elapsed-time tick to screen readers.

---

## 9. Delivery stack

Each phase is a dedicated branch/worktree and reviewable PR. Re-anchor on
current `main` before starting every phase.

### P0 — Contract fixtures and lineage foundation

**Scope**

- Freeze the exact regression scenario: legacy orchestration progress at 3/6
  after Workday with four planned source families, internal concurrency 10,
  shared activity slots 4, and jobs waiting/running in score.
- Add `DiscoveryExecutionRef` to workflow/activity inputs.
- Add `discovery_execution_jobs` and idempotent repository operations.
- Persist observed-current and pre-existing-backlog cohort membership.
- Link `JobPreparationWorkflow` inputs and safe summaries to the originating
  execution.

**Gate**

- Python migration/repository/workflow tests prove retries do not duplicate
  links, repeated source observations do not rewrite historical execution
  membership, a swept job later observed by a source is promoted into exactly
  one current-execution cohort row, pre-existing-only stragglers remain
  separate, and a missing/failed work plan cannot be mistaken for a job with no
  required work.
- Workflow replay/determinism tests pass.

### P1 — Step lifecycle and worker telemetry

**Scope**

- Emit/project orchestration-step lifecycle for source and non-stage substeps.
- Add every new event to the shared event union, MSW/SSE fixtures, and a minimal
  non-empty invalidation handler in the same PR. Until the operations query
  exists in P2/P3, invalidate the smallest existing workflow/dashboard key that
  can expose the changed lifecycle; P3 retargets/extends that handler to the
  new operations key.
- Add the allowlisted active-activity inventory.
- Extend per-process heartbeat snapshots and aggregate fresh worker capacity.
- Sample Temporal task-queue pollers/stats with unsupported/stale fallbacks.
- Add safe metrics for backlog age, add/dispatch rate, slot saturation, and
  stage duration without private content.

**Gate**

- Tests cover concurrent activities, retries, cancellation, worker crash/stale
  heartbeat, multiple worker processes, unavailable Temporal stats, and the
  invariant `activeSlots <= configuredSlots`.
- Python and TypeScript projection rebuild/repair paths fold the same step-event
  fixture into identical rows and cannot advance a shared operations watermark
  past an event the other path has not handled.
- `every-event-has-handler.test.ts` passes in P1; no phase may land a new event
  with an empty or deferred invalidation stub.
- A 32-slot/25-active fixture returns `activeSlots = 25`, 20 detail rows, and
  `activeDetailsTruncated = true`; available slots are 7, never 12.
- OpenTelemetry/Langfuse attribute tests prove no raw job, profile, prompt,
  artifact, or provider content is exported.
- Hostile-input canaries containing a raw job URL, description/profile text,
  prompt/provider output, artifact path, and secret are absent from the raw
  `pipeline_step_projections` and worker-heartbeat rows. Only the typed activity
  kind, opaque operational references, timestamps, counts, and allowlisted safe
  codes may persist.

### P2 — Operations read model and ETA

**Scope**

- Add shared contracts and API-client support for
  `GET /v1/pipeline/operations`.
- Aggregate execution phase, source progress, domain backlog, current active
  work, capacity, infrastructure queue, and freshness.
- Implement the typed ETA policy, external-contention adjustment, and
  estimator-version metadata.
- Keep `preparation_work_items` out of Temporal-native backlog calculations.

**Gate**

- API fixtures cover active, draining, completed-with-issues, failed, stale,
  unsupported, calibrating, paused, and latest-terminal-execution states.
- API serialization tests use the same hostile canaries and prove
  `GET /v1/pipeline/operations` returns none of them. Active display context is
  limited to explicitly allowlisted local projections such as title/company;
  arbitrary heartbeat/projection detail is never passed through.
- Contract parity/type tests pass across contracts, API client, API, and web.
- Query plans use indexes and remain bounded on a large synthetic database.

### P3 — Pipelines operations UI

**Scope**

- Re-anchor on the latest landed app UI redesign and record the small mapping
  from this plan's logical components to its current primitives/layout.
- Add the Operations hook/query key/invalidation mapping.
- Build the summary, source progress, capacity, stage table, and active-work
  components.
- Rename Workers to Internal concurrency with helper copy.
- Preserve current action behavior and error handling.

**Gate**

- The original regression fixture no longer renders a lone **Discover 50%
  complete** claim. For four planned families it renders **Source families 3/4
  (75%)**, shows terminal reconciliation separately, and exposes the score
  backlog, `4/4` shared-slot saturation, active work, freshness, and an ETA
  state.
- The query hook has success/error tests, and the P1 event handlers now
  invalidate the new operations key at the narrowest correct scope;
  `every-event-has-handler.test.ts` remains green.
- Colocated unit/component/type/a11y tests pass.
- Storybook has loading, discovering, draining, completed, issues, stale,
  calibrating, unavailable, and multi-worker states with zero critical/serious
  violations.
- UI assertions use roles, labels, and operational facts rather than brittle
  class names or a superseded card/table arrangement.

### P4 — Product-path QA, calibration, and documentation

**Scope**

- Add an E2E scenario that streams source progress while score work remains
  queued and running.
- Run an isolated small Discover execution with no apply/submission behavior.
- Compare UI/API counts with SQLite stage state, workflow projections, worker
  heartbeats, and Temporal's task-queue view at the same observation time.
- Evaluate the estimator against at least 20 held-out completed checkpoints
  with more than 60 seconds remaining, including at least three isolated live
  runs; adjust confidence thresholds without hiding misses.
- Update the owning user, API, architecture, observability, frontend realtime,
  requirements, and local QA docs.

**Gate**

- Browser QA proves discovery, backlog drain, retry, stale worker, and recovery
  transitions without reload.
- ETA validation records predicted range, actual completion, midpoint
  absolute/relative error, relative interval width, sample size, estimator
  version, and whether the range contained the actual result.
- The available-ETA gate requires at least 80% range containment, median
  midpoint absolute percentage error no greater than 35%, and median interval
  width no greater than 100% of actual remaining time across the held-out set.
  If the sample minimum or any threshold is missed, production returns
  `calibrating`/`unavailable`; a knowingly uncalibrated numeric ETA does not
  ship.
- No auto-apply, browser submission, destructive profile/database action, or
  real application is run.

---

## 10. Regression and QA matrix

| Scenario                                                                  | Required result                                                                                                                                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy orchestration at 3/6 with four planned families; score jobs queued | Source families says 3/4 (75%); reconciliation is separate; overall says discovering/draining; score backlog is visible                                                                     |
| Discover workflow succeeds while preparation workflows remain active      | Overall phase is draining, never complete                                                                                                                                                   |
| New execution sweeps old pending tailor work                              | Old work appears only in Execution sweep / Existing backlog; it is excluded from current-execution counts, can keep the overall execution phase draining, and is included as ETA contention |
| Swept old job is later observed by a source in the same execution         | One row is promoted to Current execution; counts and ETA never include it twice                                                                                                             |
| Large existing backlog saturates all shared slots ahead of current work   | Current cohort counts stay unchanged; ETA widens/increases or becomes unavailable, never assumes all slots are free                                                                         |
| Internal concurrency changes 10 → 20                                      | Source/enrichment internal limit changes; shared worker slots do not                                                                                                                        |
| One fresh worker with four slots, all busy                                | Capacity shows 4/4 busy and zero available                                                                                                                                                  |
| Two fresh workers with four slots each                                    | Capacity aggregates to eight; exact active counts are summed and bounded details are deduplicated per worker/activity                                                                       |
| 25 activities run in a 32-slot worker                                     | Capacity says 25 busy/7 available; active-work list says 20 of 25 and is marked truncated                                                                                                   |
| One worker heartbeat becomes stale                                        | Its slots and active items are excluded from live totals and staleness is visible                                                                                                           |
| Temporal queue stats unsupported                                          | Domain backlog remains available; infrastructure backlog says unsupported                                                                                                                   |
| Task queue has 20 activity tasks and domain score backlog has 7 jobs      | Units remain separate; the UI does not label 20 as jobs                                                                                                                                     |
| Fewer than five comparable completions                                    | ETA says calibrating with sample progress                                                                                                                                                   |
| Backlog exists, worker is unavailable                                     | ETA says paused: worker unavailable                                                                                                                                                         |
| Backlog exists, no dispatch/completion over threshold                     | ETA says paused/no dispatch and surfaces oldest waiting age                                                                                                                                 |
| New jobs arrive during crawl                                              | Estimate may increase and carries the provisional caveat                                                                                                                                    |
| Stage retry/failure/exhaustion                                            | Counts and active attempt remain inspectable; final phase is completed with issues when accounted for                                                                                       |
| Preparation planning/fan-out fails before required steps are recorded     | Work plan is failed/pending; the job is never counted ready or silently omitted                                                                                                             |
| One source family fails and others produce jobs                           | Healthy jobs continue; failed source row remains visible                                                                                                                                    |
| SSE disconnects                                                           | Polling recovers the snapshot without losing expanded state/focus                                                                                                                           |
| Long-running activity heartbeats normally                                 | Active elapsed time advances; no duplicate active item is created                                                                                                                           |
| Worker crashes mid-activity                                               | Active item becomes stale/unknown, not falsely running forever                                                                                                                              |
| Narrow/mobile viewport                                                    | Summary remains first; stage rows remain readable without hiding state/capacity/ETA labels                                                                                                  |
| App UI redesign lands before P3                                           | P3 records the component mapping, reuses the landed primitives/tokens, and preserves every operational fact without a parallel visual system                                                |
| Screen reader during 15-second refreshes                                  | Only meaningful phase changes are announced; heartbeat ticks are silent                                                                                                                     |
| Telemetry inspection                                                      | No secrets, resume/profile text, descriptions, prompts, provider responses, URLs, or artifact paths are exported                                                                            |

Any major UI/UX regression found during owner QA becomes a fixture in this
matrix or an explicit `docs/local-reliability-qa.md` checklist item before the
plan can close.

---

## 11. Documentation changes on delivery

Update the owning documents in the PR that changes each contract:

- `README.md` and `docs/user/normal-flows.md` — what Discover completion,
  backlog, capacity, and ETA mean;
- `docs/user/screenshots.md` — the final operations view after browser QA;
- `docs/local-ts-api.md` and `docs/api/operations-and-events.md` — endpoint,
  units, freshness, and SSE/refetch behavior;
- `docs/architecture/pipeline/index.md`, `concurrency.md`, and `operations.md` —
  execution lineage, shared capacity, queues, lifecycle, and estimator;
- `docs/architecture/observability.md` — safe metrics, active inventory, task
  queue stats, freshness, and privacy exclusions;
- `docs/architecture/read-model.md` — execution/job and step projections;
- `docs/architecture/frontend/integration.md` and `realtime.md` — Operations
  hook, query key, invalidation, and polling backstop;
- `docs/requirements.md` — explicit operational-visibility and honest-ETA
  requirements;
- `docs/local-reliability-qa.md` — regression matrix and live verification;
- `docs/decisions.md` — ADR for durable Discovery execution lineage and the
  local operational telemetry boundary.

When all phases and owner-path QA land, move this file to `implemented/`, add
the PRs and deviations to its status banner, and update `docs/plans/README.md`.

---

## 12. Non-goals and safety boundaries

- Do not change the shared Temporal task queue or introduce per-stage worker
  pools in this plan. This plan exposes the present topology; later capacity
  tuning must use the resulting evidence.
- Do not make the API depend on Temporal being reachable for basic domain
  backlog. Persist/snapshot operational telemetry and degrade explicitly.
- Do not query Temporal directly from the browser.
- Do not infer current-run membership from a mutable latest source observation.
- Do not use the old local `preparation_work_items` queue as a proxy for active
  Temporal work.
- Do not promise an exact finish time or show zero when the estimate is unknown.
- Do not make ETA monotonic; new jobs and retries can honestly increase it.
- Do not claim point-in-time historical queue/capacity reconstruction. The Runs
  page remains the workflow-history surface; this plan observes current
  operations and the latest execution outcome.
- Do not store arbitrary activity inputs in heartbeats, logs, spans, or
  projections.
- Do not couple visibility work to auto-apply or any submission capability.
- Do not freeze or fork the visual design while the app redesign is evolving;
  preserve the semantic contract and implement it with the current landed UI
  system.
- Do not remove existing API/CLI compatibility behavior while migrating the
  Pipelines UI.

---

## 13. Definition of done

This plan is complete only when:

1. Discovery execution/job lineage survives repeated observations, retries,
   workflow ID reuse, and application restart.
2. The Pipelines page distinguishes source crawl, current preparation drain,
   and pre-existing backlog.
3. Every operational step has an honest state, backlog semantic, processing
   count, and capacity model; unsupported data is explicit.
4. Fresh multi-worker capacity and bounded active work are visible without
   exposing private content.
5. Domain backlog and approximate Temporal task backlog use distinct labels and
   units.
6. The original 3/6 Workday regression fixture passes at component and E2E
   levels by showing the true 3/4 source-family count and separate
   reconciliation state.
7. ETA is a typed, auditable range or an explicit calibrating/paused/unavailable
   state; held-out and live QA meet the published sample, containment, midpoint
   error, and interval-width thresholds before a numeric estimate ships.
8. SSE plus polling keeps the view current without accessibility regressions.
9. Relevant checks pass: `pnpm check`, targeted API/web/Python tests, web
   type-level tests, web build, Storybook/a11y checks, and the pipeline E2E
   scenario.
10. `pr-reviewer` and `qa` both return `Gate: PASS`, with no unresolved Blocker
    or High findings.
11. Canonical docs describe the delivered behavior and this plan is archived
    with exact PR and verification evidence.
