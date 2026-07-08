# Streaming Pipeline Latency — Score As You Discover

- **Status:** Implemented / archived 2026-07-08. Delivered by #260 (plan), #301 (per-family streaming fan-out), #306 (per-job preparation handoff), #311 (gated parallel source families), and #318 (decision-resolution record). The parallel-family cap remains default-sequential unless configured.
- **Authored:** 2026-07-05
- **Owning bounded contexts:** Discovery (orchestration), Enrichment, Scoring, Materials, Pipeline/Operations (read model + progress)
- **Anchors verified against `main` @ `a488e4e9`**

## Summary

Today a job discovered early in a run cannot be scored until the **entire**
discovery-and-enrichment phase has finished. `DiscoverWorkflow` runs each source
family sequentially, then runs a single global enrichment pass, then fans out
per-job preparation **once**, at the very end. The first family's jobs sit
unscored while later families are still crawling.

This plan restructures the discovery orchestration so that **scoring starts as
soon as jobs are discovered**, and jobs that pass the score gate flow into
materials generation without waiting for the whole run to finish — while
preserving every current safety and correctness invariant: fan-out idempotence,
tolerated partial-source failure, workflow determinism/replay safety, the daily
spend ceiling, the per-job `min_score` gate, cancellation semantics, and honest
progress reporting.

It is delivered in three explicitly gated phases:

1. **Per-family streaming** — enrichment + preparation fan-out run after **each**
   family completes, not once at the end.
2. **Per-job handoff** — a job's preparation starts as soon as that job is
   enriched (event-driven or small-batch; implementer's choice).
3. **Parallel source families** — explicitly **LAST**, gated on browser/resource
   pool limits and an explicit worker-capacity analysis.

Each phase is independently shippable as a stacked PR and must pass its own
Definition of Done before the next begins.

---

## Current Behavior (verified at `a488e4e9`)

### Discovery orchestration is end-loaded

`workers/automation/src/jobctrl/discovery/workflow.py`, `DiscoverWorkflow._execute`:

- **Families run sequentially.** `for index, family in enumerate(plan.families):`
  (line ~167) awaits one `discovery_source_family_activity` at a time
  (`workflow.execute_activity(...)`, lines ~169–186). A family failure is caught
  (`except ActivityError`), appended to `failed`/`failures`, and the loop
  continues — a genuine cancellation (`_activity_error_was_cancelled`) is
  re-raised as `CancelledError`.
- **Enrichment runs once, after all families.** A single
  `discovery_enrichment_activity` call (lines ~202–217) drains detail enrichment
  globally after the loop.
- **Preparation fans out once, after enrichment.**
  `_start_preparation_workflows(...)` (call at line ~229; definition at line
  ~279) invokes `discovery_preparation_fanout_activity` (line ~285) exactly once.
- **Failure folding (must be preserved).** After the single enrichment + fan-out:
  `all_families_failed = bool(failed) and not completed` (line ~239) fails the
  workflow as `discovery_source_failed` **only** when every family failed;
  otherwise a partial-source run still runs enrichment + fan-out and **succeeds**
  with `families_failed` recorded. A non-retryable enrichment failure surfaces
  the real cause; a preparation-only error is re-raised.
- **One spend preflight for the run.** `_check_spend(payload)` (call at line ~99;
  definition at line ~309) runs `check_spend_budget` once at workflow start.

Net effect: a job discovered by the first family waits for the last family plus
the global enrichment pass before its `JobScored` event exists.

### What already streams (verify before building on it)

- **Per-job preparation is already a durable, independent workflow.**
  `JobPreparationWorkflow` (`workers/automation/src/jobctrl/preparation/workflow.py`)
  runs steps in fixed order `PREPARATION_STEP_ORDER = ("score","tailor","cover","pdf")`
  (line ~38). It runs its **own** spend preflight when a step spends
  (`_preparation_spends` → `_check_spend`, lines ~91–92, ~225–235), and the
  expensive stages are gated on `min_score` (passed into
  `tailor_job_activity` / `cover_letter_activity`, lines ~185, ~206).
- **Fan-out already starts root workflows with deterministic, deduped ids.**
  `start_discovery_preparation_workflows`
  (`workers/automation/src/jobctrl/pipeline/preparation.py`, line ~74) derives
  targets from the DB (`derive_preparation_targets` → `get_jobs_by_stage`
  `pending_score` / `pending_tailor`), builds one `WorkflowStartSpec` per job with
  `workflow_id = preparation_workflow_id(idempotency_key)` = `prep-{idempotency_key}`
  and `id_conflict_policy = WorkflowIDConflictPolicy.USE_EXISTING` (lines
  ~174–179, ~282–287), and starts them in batches of
  `PREPARATION_CHILD_BATCH_SIZE = 25` (line ~43).
- **The idempotency key is a pure function.**
  `make_preparation_idempotency_key`
  (`workers/automation/src/jobctrl/domain/preparation/work_items.py`, line ~116)
  is `"preparation:" + sha256({tenant_id, job_id, kind, target_version, source_event_id})`.
  `source_event_id` is the latest relevant `job_events` row for the job
  (`_latest_source_event_id`, `pipeline/preparation.py` line ~310).
- **`USE_EXISTING` dedupe lives at the client layer.** `default_workflow_starter`
  (`workers/automation/src/jobctrl/infrastructure/rpc/workflow_starter.py`)
  applies `USE_EXISTING` so a double-start of a deterministic id returns the
  already-running handle. **Note:** today's fan-out returns `started` = number of
  specs it attempted and `queued` = total specs; these counts are **not** a
  dedupe signal — actual dedupe is the Temporal id-conflict policy. Any
  streaming design that wants to *report* dedupe must add that signal explicitly
  (see Open Owner Decisions).
- **Jobs appear in the UI incrementally per family** through the append-only
  `job_events` log → projection builders → `GET /v1/events/stream` (250 ms
  poller) → TanStack Query invalidation (see
  `docs/architecture/pipeline/operations.md`). But they appear **unscored** until
  the end-of-run fan-out, because no `JobScored` event exists for them yet.

### Concurrency model (constrains Phase 3)

Per `docs/architecture/pipeline/concurrency.md`: a **single** worker process
executes every activity; capacity is `JOBCTRL_MAX_CONCURRENT_ACTIVITIES`
(default `4`) activity slots plus a `slots + 2` `ThreadPoolExecutor`, both fixed
at worker startup. Families run sequentially today **for isolation, not
throughput**. Parallelising source families is not a filed backlog item; the
filed item (`docs/backlog.md`) is parallelising search-combination execution
*inside* one family. Browser/Playwright contention is the first-class Phase 3
risk (see Risks).

---

## Goals

- A job discovered by an early family is **scored while later families are still
  discovering** (Phase 1), and ideally **as soon as it is individually enriched**
  (Phase 2).
- Jobs passing the `min_score` gate flow into tailoring/cover/PDF **mid-run**,
  not after the whole run finishes.
- **Time To First Score (TTFS)** — defined below — drops materially versus the
  end-loaded baseline, measured on a controlled run.

## Non-Goals

- Changing scoring logic, the scoring policy, tailoring quality gates, or the
  `min_score` semantics. Streaming changes *when* a job is scored, never *how* or
  *whether* it passes.
- Changing apply behavior or apply safety. Apply remains a separate,
  human-gated stage.
- Removing the tolerated-partial-failure semantics, the single run-level spend
  preflight, or per-job preflight. Streaming is additive to these guarantees.
- Speeding up crawling itself (that is the separate in-family
  search-combination backlog item).
- Multi-worker / hosted scale-out. Everything here targets the single local
  worker.

---

## Cross-Cutting Invariants And Contracts

These hold across **all three phases**. A phase is not done if any regresses.

### I1 — Fan-out idempotence under repeated invocation

Streaming multiplies the number of fan-out invocations per run (once per family,
or once per enriched job). The mechanism that makes this safe already exists and
**must be preserved, not re-implemented**:

- The per-job workflow id is deterministic: `prep-{idempotency_key}` where the
  key is `make_preparation_idempotency_key(...)` — a pure hash of
  `{tenant_id, job_id, kind, target_version, source_event_id}`.
- `WorkflowIDConflictPolicy.USE_EXISTING` makes a repeated start of the same id
  return the open handle instead of a second execution.

**Contract:** for a fixed `(job, target_version, source_event_id)`, N fan-out
invocations start **exactly one** `JobPreparationWorkflow` execution. Implementers
MUST prove this with a fixture (see each phase). Implementers MUST also account
for the `source_event_id` nuance: if a new relevant `job_events` row lands for a
job between fan-out invocations, the key changes and a *new* prep workflow is
legitimately started. The design must ensure this only happens on a genuine
material change (e.g., re-enrichment producing a new snapshot), never on a benign
repeated pass — and must document which event types feed `_latest_source_event_id`.

### I2 — Tolerated partial-source failure (failure folding)

The current folding logic (`workflow.py` lines ~239–276) is a hard requirement.
Under streaming:

- A family that fails **after** earlier families already fanned out MUST NOT undo
  or cancel those earlier fan-outs. Fanned-out prep workflows are independent
  **root** workflows (started via the client, `ParentClosePolicy` does not apply);
  they already survive discovery completion. They must equally survive a later
  family's failure.
- The run's terminal status folding is unchanged: **succeed** if ≥1 family
  completed (recording `families_failed`); **fail** as `discovery_source_failed`
  only when **every** family failed; surface the real enrichment error on a
  non-retryable enrichment failure.
- Enrichment failures remain tolerated where they are tolerated today.

### I3 — Determinism / replay safety

`DiscoverWorkflow` is Temporal workflow code and must remain deterministic:

- The number and order of activity invocations must be a deterministic function
  of `plan.families` (a deterministic, ordered list) and of prior activity
  results already in history. Conditional fan-out ("only after a family that
  completed") is allowed because the completed/failed decision derives from the
  activity result, which is durable in history.
- No wall-clock branching, no nondeterministic iteration, no reading of external
  state in workflow code. All DB reads / side effects stay **inside activities**
  (as `discovery_preparation_fanout_activity` already does).
- The `test_discover_workflow_kill_worker_resumption` proof
  (`test_workflow_discovery.py`) MUST still pass: killing the worker mid-family,
  restarting, and completing the run with redelivery and no reaper.

### I4 — Spend ceiling holds under streaming (bounded cost per discovered job)

Per `docs/architecture/pipeline/operations.md`: `check_spend_budget`
(`workers/automation/src/jobctrl/llm.py`, line ~143) is a **preflight**;
`daily_budget_usd` defaults to `$25`, `0` means unlimited, and an exceeded budget
raises non-retryable `BudgetExceededError`.

**Contract under streaming:**

- The run-level discover preflight (`_check_spend`) remains.
- Every per-job `JobPreparationWorkflow` keeps its own preflight
  (`_preparation_spends` → `_check_spend`). This is what bounds cost per
  discovered job: once the day's ledger reaches the cap, a job fanned out *mid-run*
  fails fast at its preflight and spends nothing further.
- Streaming must not create an unbounded multiplier of *spendful* work. Fan-out
  frequency (per-family or per-job) increases the number of **preflight reads**,
  not the number of jobs scored — each job is still scored at most once
  (I1 dedupe). A budget-under-streaming fixture is required (see Phase 1/2).

### I5 — `min_score` gate holds under streaming

The `score → tailor → cover → pdf` order inside `JobPreparationWorkflow` and the
`min_score` gate on tailor/cover are unchanged. Streaming changes only when a job
enters its prep workflow, never the intra-job gate order. A job below `min_score`
still stops after score; expensive stages still never run for it.

### I6 — Cancellation, heartbeats, and timeouts stay correct

- Each activity keeps its existing `heartbeat_timeout` (2 min) and timeouts
  (source/enrichment 6 h; plan/fan-out 30 min).
- Canceling the run must still propagate: an in-flight family or enrichment
  activity cancels cooperatively (`_activity_error_was_cancelled` →
  `CancelledError`), and **no further fan-outs are started after cancellation is
  observed**. Already-started per-job prep workflows follow their own
  cancellation contract (they are separate root workflows; canceling discovery
  does not cancel them — document this explicitly, it is existing behavior).
- The discovery-cancel-all-sources regression
  (`test_p1b_error_inversion.py`, `test_workflow_discovery.py`) must still pass.

### I7 — Honest, monotonic progress and read model

- The Runs view progress must remain **truthful and monotonic** — it must never
  regress a percentage or present a dead run as running. Today
  `progress_total = len(plan.families) + 2` and `_discovery_progress_payload`
  (`pipeline/runner.py` line ~190) drives the bar. Per-family streaming changes
  the step cadence (enrichment + preparation now recur per family); the plan
  owner MUST choose and document a progress model that stays monotonic (see Open
  Owner Decisions).
- Scores must appear **incrementally**: the read path (`job_events` → projections
  → SSE) already supports this; the only change is that `JobScored` events now
  arrive earlier and interleaved with discovery.

### TTFS — the headline metric

**Time To First Score (TTFS)** = wall-clock elapsed from the **first job persisted
in a run** to the **first score visible in the read model / UI for that run**.

- **Job persisted** signal: the first `JobDiscovered` event for the run in
  `job_events`.
- **Score visible** signal: the first `JobScored` event for the run in
  `job_events` (this is what the projection builders fold into
  `job_list_projections` / `job_detail_projections` and what the SSE poller
  surfaces). `JobScored` is the canonical event on both runtimes
  (`packages/domain-types/src/events/scoring.ts`;
  `workers/automation/src/jobctrl/domain/events/scoring.py`).
- **Structural proxy (checkable in CI):** the ORDER invariant that a family's
  enrichment + fan-out occurs **before** the next family completes. This is what
  the phase regression fixtures assert deterministically; the wall-clock number
  is a manual/owner QA measurement (below), because a real end-to-end TTFS run
  spends LLM budget and must not run in CI or unattended agents.

---

## Phase 1 — Per-Family Streaming

**Objective:** run enrichment + preparation fan-out **after each family
completes**, so the first family's jobs are scored while later families still
discover.

### Design objective (not a prescription)

Restructure `DiscoverWorkflow._execute` so that, for each family that **completes**
in the sequential loop, the workflow drains that family's newly-discovered jobs
through enrichment and then fans out preparation — instead of a single global
enrichment + fan-out after the loop. Implementers choose whether to:

- (a) call `discovery_enrichment_activity` + `discovery_preparation_fanout_activity`
  after each completed family and drop the terminal global pass, or
- (b) keep a final reconciling enrichment + fan-out pass after the loop as a
  safety net.

Either way the following invariant holds: **every enriched job receives exactly
one eligible fan-out attempt, and no eligible job is left unscored at run end.**

The enrichment activity already drains *pending* detail enrichment globally
(`run_discovery_enrichment_stage`), so invoking it repeatedly is naturally
incremental and idempotent — each pass drains whatever is pending, which after
family K is family K's fresh jobs. The fan-out reads `pending_score` /
`pending_tailor` from the DB, so a job only becomes a target once enrichment has
advanced it; repeated fan-out is deduped by I1.

### Acceptance template

- **Source of truth:** `job_events` (append-only) for discovery, enrichment,
  score, and workflow-lifecycle facts; the `jobs` stage rows
  (`pending_score` / `pending_tailor`) that `derive_preparation_targets` reads.
- **Owning bounded context:** Discovery (the `DiscoverWorkflow` orchestration and
  its activities), with Enrichment and Scoring as the downstream contexts whose
  events now arrive earlier.
- **Projection / read model:** `job_list_projections` / `job_detail_projections`
  (scores appear incrementally); `workflow_run_projections` and the
  `discovery_runs` progress payload (per-family progress). No new projection
  columns are required for Phase 1; if the owner chooses a richer progress model,
  changes stay within the existing `discovery_runs` progress payload and both
  projection builders must stay in parity.
- **UI surface:** Runs view (per-family progress, truthful + monotonic) and Jobs
  view / Dashboard (scores and score badges appear mid-run). No new user action.
- **Approving user action:** none — Phase 1 is orchestration only; it must not
  auto-start apply or any human-gated stage.
- **Synthetic regression fixtures (required):**
  1. **Interleaving proof** — extend `test_workflow_discovery.py`'s
     `test_discover_workflow_runs_sources_then_enrichment_and_fanout`. Its current
     assertion of the exact event order
     `["workflow_started","plan","source","source","source","enrichment","fanout","workflow_outcome"]`
     (lines ~303–312) MUST be updated (extend, do not delete the test) to assert
     the new interleaved order — enrichment + fanout appear **after each
     completed family**, e.g. `... source, enrichment, fanout, source, enrichment,
     fanout, ...` — proving a family's jobs are prepared before the next family
     runs.
  2. **Partial-failure-under-streaming** — extend
     `test_discover_workflow_tolerates_partial_source_failure` and
     `test_discover_workflow_fails_only_when_every_source_fails`: a family failing
     after an earlier family already fanned out must leave the earlier fan-out
     intact, keep `families_failed` recorded, and preserve the terminal folding
     (succeed on ≥1 completion; fail only on all-fail). I2.
  3. **Fan-out idempotence** — extend
     `test_discovery_preparation_orchestration.py`: invoking the per-family
     fan-out across two families where the second adds no new eligible jobs
     requests the **same** deterministic `prep-{idempotency_key}` ids and (with a
     fake starter simulating `USE_EXISTING`) starts **zero** duplicate
     executions. I1.
  4. **Budget-under-streaming** — with `check_spend_budget` reporting exceeded
     partway through a run, a per-job prep workflow fanned out after family 1
     fails fast with non-retryable `budget_exceeded` and performs no spendful
     activity; earlier fan-outs are unaffected. Compose from
     `test_llm_spend_budget.py` + `test_workflow_job_preparation.py` patterns. I4.
  5. **Resumption still holds** — `test_discover_workflow_kill_worker_resumption`
     must pass unchanged in intent (update only for the new interleaved order).
     I3/I6.
- **Local QA path:** in a **disposable** seeded workspace (never the user's real
  data), run a small discovery over ≥2 families and observe in the Runs view that
  the first family's jobs show scores while a later family is still crawling, and
  that progress advances monotonically to a truthful terminal state. Measure TTFS
  per the protocol below. Do not run auto-apply, mailbox scanning, or destructive
  actions.

### Definition of Done — Phase 1

- Enrichment + fan-out run per completed family; no eligible job is unscored at
  run end.
- All five fixtures above pass; existing `test_workflow_discovery.py`,
  `test_discovery_preparation_orchestration.py`, `test_p1b_error_inversion.py`,
  and `test_discover_reliability.py` pass (updated only for the new order, never
  weakened).
- I1–I7 demonstrably hold; the regression matrix in
  `docs/local-reliability-qa.md` gains a "score-as-you-discover / per-family
  streaming" row (see Verification).
- Docs updated: `docs/architecture/pipeline/index.md` (workflow catalog +
  `DiscoverWorkflow` description), `concurrency.md` ("Where Fan-out Happens"),
  and `operations.md` (progress model) reflect per-family streaming.
- Owner has recorded a TTFS before/after measurement from a controlled run.

---

## Phase 2 — Per-Job Handoff

**Objective:** a job's preparation starts **as soon as that job is enriched**,
rather than after its whole family's enrichment pass — tightening TTFS to
per-job granularity.

### Design objective (not a prescription)

As enrichment advances an individual job to `pending_score`, start that job's
`JobPreparationWorkflow` promptly. The mechanism is the implementer's choice at
high reasoning effort — for example:

- **Event-driven:** the enrichment activity starts each job's prep workflow as it
  finishes that job (using the same deterministic-id + `USE_EXISTING` start), or
- **Small-batch polling:** a tight fan-out cadence (small batch size / short
  interval) that picks up newly-`pending_score` jobs quickly.

The choice must weigh Temporal history size, activity-slot pressure, and DB read
frequency against latency. Whatever the mechanism, the guarantees are identical
to Phase 1.

### Acceptance template

- **Source of truth:** unchanged from Phase 1 (`job_events`, `jobs` stage rows).
- **Owning bounded context:** Enrichment (the point at which a job becomes
  prep-eligible) coordinating with Discovery's fan-out; Scoring downstream.
- **Projection / read model:** unchanged; scores simply arrive at finer
  granularity. Both projection builders remain in parity.
- **UI surface:** Jobs view / Dashboard — scores trickle in job-by-job. Runs view
  progress remains truthful.
- **Approving user action:** none.
- **Synthetic regression fixtures (required):**
  1. **Per-job promptness** — a job enriched early triggers its prep workflow
     before its siblings in the same family are enriched (structural proxy for
     lower TTFS).
  2. **Idempotence at per-job granularity** — the same job enriched once starts
     exactly one prep workflow even if the per-job handoff and any residual
     batch/reconciling pass both observe it (I1); a re-enrichment that produces a
     new `source_event_id` legitimately starts a new prep workflow, and this is
     asserted to happen **only** on a material change.
  3. **Budget-under-streaming at per-job granularity** — same as Phase 1 fixture
     4, but proving each per-job handoff independently preflights and fails fast
     once the cap is hit (I4).
  4. **Determinism/replay** — if the handoff is driven from workflow code, prove
     the activity-call sequence stays deterministic; if driven from inside the
     enrichment activity, prove the workflow history is unaffected (side effects
     stay in the activity). I3.
- **Local QA path:** disposable seeded workspace; observe scores appearing
  job-by-job during a single family's enrichment; measure TTFS improvement over
  Phase 1.

### Definition of Done — Phase 2

- A job is scored shortly after it is individually enriched, not after its whole
  family.
- All Phase 2 fixtures pass; all Phase 1 guarantees and fixtures still pass.
- I1–I7 hold at per-job granularity.
- Docs updated where the handoff cadence is described
  (`docs/architecture/pipeline/index.md`, `concurrency.md`, `operations.md`).
- Owner has recorded a TTFS measurement showing per-job handoff ≤ per-family.

---

## Phase 3 — Parallel Source Families (LAST, gated)

**Objective:** run multiple source families **concurrently** so total discovery
wall-clock drops — **only after** Phases 1–2 have made early jobs already
score-visible, and **only** behind explicit concurrency bounds.

This phase is deliberately last and is **gated**. It must not be attempted until
Phases 1–2 are delivered and the browser/resource risks below are resolved with
an explicit bound and a worker-capacity analysis.

### Why it is gated — browser/resource contention is first-class

- The worker is single-process with `JOBCTRL_MAX_CONCURRENT_ACTIVITIES`
  (default `4`) activity slots and a `slots + 2` executor
  (`docs/architecture/pipeline/concurrency.md`). Running families in parallel
  means multiple `discovery_source_family` activities in flight at once, **each**
  potentially launching a headless browser (Playwright) plus its own in-source
  scraping workers. Parallelism is already bounded by activity slots (Temporal
  queues the excess), so naive `asyncio.gather` over families does **not** give
  unbounded speed-up — but it **can** give unbounded *browser* concurrency within
  those slots.
- There is operational history of uncontrolled browser concurrency destroying
  long runs. Browser-instance contention (memory, GC across processes, crashes)
  is the primary Phase 3 risk and must be treated as first-class.

### Requirements before enabling

- **Explicit concurrency bound.** Introduce a hard, configurable cap on
  simultaneously-active families and/or a browser-instance pool/semaphore so the
  number of concurrent browsers never exceeds a proven-safe bound (≤ activity
  slots, and independently capped for browser-launching families).
- **Worker-capacity analysis.** Document, for the target bound: peak concurrent
  browsers, peak activity slots consumed, executor-thread pressure, and memory
  headroom on a representative local machine. Show that the chosen bound leaves
  slots for the interleaved enrichment + fan-out + per-job prep workflows from
  Phases 1–2 (they compete for the same slots).
- **Preserve isolation + folding.** Parallel families must keep per-family
  activity timeout/heartbeat/retry isolation and the exact partial-failure
  folding (I2). Cancellation must fan out to **all** in-flight families
  cooperatively (extend the cancel-all-sources regression).
- **Determinism.** Concurrent activity scheduling must remain replay-safe (deterministic
  start order of the parallel activities; results folded deterministically).

### Acceptance template

- **Source of truth:** unchanged.
- **Owning bounded context:** Discovery orchestration + the worker capacity
  configuration (`infrastructure/temporal/worker.py`).
- **Projection / read model:** unchanged; per-family progress must stay truthful
  even when families advance concurrently (progress model must handle concurrent
  step advancement without regressing the bar). I7.
- **UI surface:** Runs view (concurrent per-family progress) and Dashboard/Jobs
  (scores continue to stream). No new user action.
- **Approving user action:** none for running; the concurrency bound is
  process/env configuration (like `JOBCTRL_MAX_CONCURRENT_ACTIVITIES`), not a
  runtime toggle — document the restart requirement as with existing capacity
  knobs.
- **Synthetic regression fixtures (required):**
  1. **Bound enforced** — with N families and a cap of M < N, prove no more than
     M families (and no more than the browser cap) are active concurrently.
  2. **Parallel partial-failure folding** — a family failing while others run in
     parallel preserves I2 folding and leaves peers' fan-outs intact.
  3. **Cancel-all under parallelism** — canceling the run cooperatively cancels
     **every** in-flight family (extend the existing cancel-all-sources tests).
  4. **Determinism/replay** under concurrent scheduling.
- **Local QA path:** disposable seeded workspace; run parallel families under the
  cap and confirm (via operational metrics / logs) that concurrent browser count
  never exceeds the bound and the run completes with truthful progress. Long-run
  soak is an owner responsibility given the historical browser-GC incident.

### Definition of Done — Phase 3

- Families run concurrently under a proven, configurable bound; concurrent
  browser count never exceeds the cap.
- Worker-capacity analysis is documented in
  `docs/architecture/pipeline/concurrency.md`.
- All Phase 1–2 guarantees and fixtures still pass; Phase 3 fixtures pass.
- I2/I3/I6/I7 demonstrably hold under parallelism.
- Owner sign-off after a controlled longer run confirms no browser-contention
  regression.

---

## Verification

Run the touched-surface subset of the CLAUDE.md matrix. Python is the primary
surface; the read model touches both runtimes.

```bash
# Python worker (primary surface) — extend, do not replace, these suites:
uv --project workers/automation run --extra dev pytest -q \
  workers/automation/tests/test_workflow_discovery.py \
  workers/automation/tests/test_discovery_preparation_orchestration.py \
  workers/automation/tests/test_workflow_job_preparation.py \
  workers/automation/tests/test_discover_reliability.py \
  workers/automation/tests/test_p1b_error_inversion.py \
  workers/automation/tests/test_llm_spend_budget.py \
  workers/automation/tests/test_pipeline_observability.py

# Full Python suite + lint
uv --project workers/automation run --extra dev pytest -q
uv --project workers/automation run --extra dev ruff check .

# Cross-stack (API Vitest + web build + Python) — projection parity if read model touched
pnpm check
pnpm test

# If the read model / projections change, also:
uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_audit_projection_parity.py
pnpm api:test
git diff --check
```

**Regression matrix entry (required in `docs/local-reliability-qa.md`).** Add a
row under "High-Risk Regression Areas" for streaming, worded so it can only be
satisfied by the invariant, not a shallow snapshot. Suggested risk statement:

> Score-as-you-discover streaming regresses: enrichment/preparation fan-out
> reverts to running once at end-of-run (a job discovered early stays unscored
> until the run finishes); a repeated per-family/per-job fan-out starts duplicate
> `JobPreparationWorkflow` executions instead of reusing the deterministic
> `prep-{idempotency_key}` id via `USE_EXISTING`; a later family's failure undoes
> earlier fan-outs or breaks the tolerated-partial-failure folding; a job fanned
> out mid-run bypasses the per-job spend preflight or the `min_score` gate; or the
> Runs progress bar regresses / misreports per-family progress.

with automated coverage citing the fixtures above
(`test_workflow_discovery.py`, `test_discovery_preparation_orchestration.py`,
`test_workflow_job_preparation.py`, `test_llm_spend_budget.py`,
`test_p1b_error_inversion.py`) plus the manual TTFS QA below.

**Temporal fault-injection matrix.** Re-verify the `DiscoverWorkflow` row of the
matrix in `docs/local-reliability-qa.md` still holds after restructuring
(kill-worker resumption, cancel propagation, Temporal-unreachable-at-start,
history wipe → reconciler).

### TTFS QA measurement protocol (manual / owner-run)

CI cannot spend LLM budget, so wall-clock TTFS is measured by the owner (or in a
supervised QA session), never by an unattended agent:

1. Seed a **disposable** workspace (e.g. `pnpm qa:seed -- /tmp/jobctrl-ttfs`)
   and point a full local stack at it via `JOBCTRL_DIR` / isolated ports; confirm
   `GET /v1/health` reports `worker.status: "healthy"` first.
2. Start a small discovery over ≥2 families with a low `limit`.
3. From `job_events` (durable, canonical), compute TTFS = first `JobScored`
   timestamp − first `JobDiscovered` timestamp for the run. Record the same for a
   baseline build (end-loaded) and the streaming build.
4. Confirm in the UI that scores appear mid-run and progress stays monotonic.
5. Do **not** run auto-apply, browser submission, mailbox scanning, or
   destructive profile/database actions during this QA.

The **structural** proxy (event-order interleaving fixtures) is the CI gate; the
wall-clock number is the owner acceptance signal per phase.

---

## Risks

- **Browser/resource contention (Phase 3, highest).** Concurrent families can
  launch concurrent browsers; historical incidents show uncontrolled browser
  concurrency killing long runs. Mitigation: explicit bound + pool/semaphore +
  worker-capacity analysis; Phase 3 gated behind Phases 1–2 and owner soak.
- **Idempotency-key drift.** If re-enrichment or a benign repeated pass mutates
  `_latest_source_event_id` for a job, a second prep workflow starts. Mitigation:
  document exactly which `job_events` types feed the key; fixtures assert a new
  prep starts **only** on a material change.
- **Progress-model dishonesty.** Recurring per-family enrichment/fan-out steps can
  make a naive `completed/total` bar non-monotonic or misleading. Mitigation: I7
  requires a chosen, documented, monotonic progress model with parity across both
  projection builders (owner decision below).
- **Activity-slot starvation.** Per-family/per-job fan-out plus interleaved prep
  workflows plus (Phase 3) parallel families all compete for the same `4` default
  slots; latency gains can be eaten by queueing. Mitigation: capacity analysis;
  the default slot count and its restart-to-change semantics are documented and
  unchanged.
- **Determinism regressions.** Restructuring workflow control flow risks
  non-deterministic replays. Mitigation: I3 fixtures + the kill-worker resumption
  proof.
- **Read-model parity drift.** Any projection change must land in **both** the
  Python `ProjectionBuilder` and the TypeScript `refreshProjections`; the parity
  tests are the backstop.

---

## Open Owner Decisions

> **Resolution record (2026-07-06):** all five decisions below were resolved
> during implementation and the R9 stack is merged (plan #260 → #301 Phase 1 →
> #306 Phase 2 → #311 Phase 3). Original decision text is preserved; the
> as-implemented resolution is appended to each item.

1. **Progress model under streaming (I7).** Today `progress_total = len(families)
   + 2` with a single enrichment + preparation step. Options: (a) keep families as
   the top-level bar and treat per-family enrichment/fan-out as sub-steps; (b)
   expand the total to `families × (crawl + enrich + fanout)`; (c) report families
   completed as the spine and stream job-score counts separately. Must be
   monotonic and truthful. **Owner to choose before Phase 1 implementation.**
   **Resolved (2026-07-06, #301):** kept the fixed denominator
   `len(families) + 2`; each family's enrichment + fan-out folds into that
   family's step, so families remain the monotonic spine, and score arrival
   streams independently via `JobScored` events rather than the progress bar.
   Known limitation: under Phase-3 parallelism (cap > 1) the bar can regress —
   recorded as a review Medium on #311 and accepted while the default cap is 1;
   it must be resolved before the cap is raised.
2. **Phase 1 shape:** per-family enrichment + fan-out with **no** terminal global
   pass (a), or with a final reconciling pass as a safety net (b). Trade-off:
   simplicity/latency vs. a guaranteed sweep for stragglers.
   **Resolved (2026-07-06, #301/#306):** option (b) — per-family streaming
   enrichment + fan-out with the terminal reconcile enrichment + fan-out pass
   KEPT after the family loop as the safety net. The terminal pass always runs
   and remains authoritative for failure folding and progress finalization
   (`discovery/workflow.py:219-257`; fixture `test_workflow_discovery.py:394-416`
   pins it as "plan option (b)"). The pre-loop `pending_tailor` sweep added with
   Phase 2 is an additional straggler net and closes the double-tailor race
   found in review. A workflow-level sweep-runs-once fixture remains a recorded
   follow-up (review Medium on #301).
3. **Phase 2 mechanism:** event-driven per-job start from inside the enrichment
   activity vs. tight small-batch polling. Trade-off: Temporal history size and
   coupling vs. latency.
   **Resolved (2026-07-06, #306):** event-driven — the `on_job_enriched` handoff
   inside the enrichment activity starts the per-job `PreparationWorkflow`
   (deterministic id + `USE_EXISTING`); polling was rejected.
4. **Report true dedupe counts?** Today `started`/`queued` are not a dedupe
   signal. Optionally add an explicit "already-open / deduped" count so the Runs
   view can show how many fan-out attempts reused an existing prep workflow.
   Non-blocking; nice-to-have for observability.
   **Resolved (2026-07-06):** deferred — not built in R9. `USE_EXISTING` dedupe
   remains silent; the explicit deduped count stays a backlog observability
   item.
5. **Phase 3 concurrency bound + browser pool sizing.** The exact
   max-parallel-families and browser-instance cap, and whether the browser pool is
   a new env knob alongside `JOBCTRL_MAX_CONCURRENT_ACTIVITIES`. Requires the
   worker-capacity analysis. **Blocks Phase 3.**
   **Resolved (2026-07-06, #311):** the bound is the env knob
   `JOBCTRL_MAX_PARALLEL_DISCOVERY_FAMILIES`, default `1` (byte-equivalent
   sequential ordering; the knob is read only inside the activity, keeping
   workflow replay safe). No separate browser-pool knob was added — browser use
   stays bounded by the existing activity slots. Raising the cap above 1 is
   owner-gated on a soak run plus resolving the progress-bar Medium in item 1.

---

## Anchor Reference (verified @ `a488e4e9`)

| Anchor | Location |
| --- | --- |
| Sequential family loop; single global enrichment; end-of-run fan-out; failure folding | `workers/automation/src/jobctrl/discovery/workflow.py` (`_execute`, lines ~152–276; loop ~167; enrichment ~202; `_start_preparation_workflows` ~229/~279; fold ~239) |
| Run-level spend preflight | same file, `_check_spend` call ~99, def ~309 |
| Root-workflow fan-out via `USE_EXISTING` | `workers/automation/src/jobctrl/discovery/activities.py`, `discovery_preparation_fanout_activity` ~218 (dedup note ~226–228) |
| Deterministic id + `USE_EXISTING`; batch size 25; target derivation | `workers/automation/src/jobctrl/pipeline/preparation.py` (`start_discovery_preparation_workflows` ~74; ids ~177/~285; `USE_EXISTING` ~178/~286; `PREPARATION_CHILD_BATCH_SIZE` ~43; `derive_preparation_targets` ~61/~88) |
| Pure idempotency key | `workers/automation/src/jobctrl/domain/preparation/work_items.py`, `make_preparation_idempotency_key` ~116 |
| Per-job step order, per-job preflight, `min_score` gate | `workers/automation/src/jobctrl/preparation/workflow.py` (`PREPARATION_STEP_ORDER` ~38; `_preparation_spends`/`_check_spend` ~91/~225; tailor/cover `min_score` ~185/~206) |
| Spend ceiling preflight + defaults | `workers/automation/src/jobctrl/llm.py` (`check_spend_budget` ~143; `read_spend_budget_status` default `$25` ~124–129) |
| `JobScored` event (TTFS score signal) | `packages/domain-types/src/events/scoring.ts`; `workers/automation/src/jobctrl/domain/events/scoring.py` |
| Worker capacity + sequential-for-isolation rationale | `docs/architecture/pipeline/concurrency.md` |
| Spend ceiling, progress payload, SSE read path | `docs/architecture/pipeline/operations.md`; `pipeline/runner.py` `_discovery_progress_payload` ~190 |
| Existing discovery workflow tests (extend, do not replace) | `workers/automation/tests/test_workflow_discovery.py`; `test_discovery_preparation_orchestration.py`; `test_workflow_job_preparation.py`; `test_discover_reliability.py`; `test_p1b_error_inversion.py`; `test_llm_spend_budget.py` |
| In-family parallelism backlog item (distinct from Phase 3) | `docs/backlog.md` |

## Delivery Model: Stacked PRs On This Plan

Implement this plan as a series of stacked PRs that begin on this plan's
branch:

- The first implementation PR uses this plan PR's branch as its base; each
  subsequent PR stacks on the previous one. One reviewable concern per PR;
  Conventional Commit titles.
- As a parent merges, retarget the next PR to `main` before merging it
  (retarget-before-merge; never merge a PR whose base branch is already
  merged and deleted).
- If this plan PR has already merged to `main`, start the stack from `main`
  instead — the instruction is "stack on the plan", not "recreate it".
- Each PR states which plan phase it delivers and runs that phase's
  verification commands from this plan before requesting review.
- Do not begin implementation while this plan's stated gates or
  dependencies are unmet.
