# Operations & Events

The cross-cutting mechanics that keep the pipeline running day to day under
Temporal (the workflow engine): the daily spend ceiling, the (off-by-default)
discovery schedule, where every stage persists, how domain events reach the web
app over Server-Sent Events (SSE), how read-model projections recover after a
crash, and how the pipeline behaves when things fail.

**Read this if** you are setting a budget, scheduling discovery, tracing where a
stage's data lands, or working out how the system recovers from a failure.

## Spend Ceiling

A daily spend ceiling backstops LLM cost. The `check_spend_budget` activity
(`llm.py`) is the preflight in every spendful workflow. It reads the budget
status (`read_spend_budget_status`): `daily_budget_usd` defaults to **$25**
(`read_daily_budget_usd(default=25.0)`), and a value of **0 means unlimited**. If
today's `llm_spend` ledger already meets the ceiling, it raises
`BudgetExceededError` (`budget_exceeded`, non-retryable), failing the run before
any paid work. Because the preflight runs with `maximum_attempts=1`, a depleted
budget is a clean fast failure, not a retry storm.

Per-call cost is written to the `llm_spend` UPSERT ledger, keyed by day, using
per-model-family rates (`estimate_llm_cost_usd` in `llm.py`); the rates are
coarse family buckets, and models without a listed family fall back to a
generic rate, so the ledger is an estimate, not billing truth. The ceiling is a *preflight gate* per workflow, not a
mid-call interrupt: a single expensive run already in flight is not aborted, but
the next spendful workflow will not start once the day's ledger is at the cap.

Supervised contact research (`ContactResearchWorkflow`, Contact & Outreach) is a
spendful workflow and reuses this **same** preflight — the `check_spend_budget`
activity + the `dailyBudgetUsd` ledger — before its LLM candidate extraction.
There is no second spend table or preflight.

## Standing Auto-Apply Loop

Auto apply is a settings-reconciled continuous Apply workflow, not a hidden UI
shortcut. The `auto_apply` setting defaults to **false**. When it is **true**,
the Python worker ensures one deterministic workflow id,
`apply-auto-local`, is running on the worker task queue with
`ApplyWorkflowInput(continuous=True, auto_apply_loop=True)`. When it is
**false**, the worker cancels that deterministic workflow if it exists. The
reconciler runs at worker startup and from the worker heartbeat loop, so
turning the setting on or off takes effect without restarting the worker.

The loop intentionally reuses the existing continuous poll mode in
`ApplyWorkflow` and `apply.launcher.worker_loop`:

- `apply_approval_required` is re-read by the apply activity at claim time. With
  the default **true** value, the loop submits only jobs already approved in
  Apply Review and parks unapproved jobs as awaiting approval. With **false**,
  the loop may submit eligible prepared jobs autonomously.
- `min_fit_score` and `apply_concurrency` are re-read by auto-apply activities,
  so threshold and fan-out changes affect later polls without recreating the
  workflow.
- The spend ceiling still runs as the workflow preflight. A depleted budget
  fails the standing loop before browser apply work starts, instead of retrying
  into a spend storm. The reconciler treats that failed projection as a budget
  halt and does not restart the loop while today's spend remains at or above the
  configured ceiling.
- The existing launcher protections remain the source of truth: dry-run apply
  paths never submit, submit-intent tracking enforces at-most-once, and CAPTCHA
  or third-party challenge handling fails closed.

Because the loop is a normal workflow run, it is projected into
`workflow_run_projections` and appears in the Runs / Operations surface as
**Standing apply loop**. Automation is therefore visible and cancelable from the
same place as manually-started runs.

## Discovery Schedule

Scheduled discovery is **off by default**. A single Temporal Schedule,
`jobctl-discovery-local`, can run `DiscoverWorkflow` on a cron expression, but
it is reconciled from settings only at **worker startup**
(`_reconcile_discovery_schedule` in `cli.py`, before `worker.run()`):

- It reads `load_discovery_schedule_settings()` → `(enabled, cron)`.
- If **disabled**, it deletes the schedule handle (idempotent) and returns.
- If **enabled**, it creates (or updates) the schedule to start
  `DiscoverWorkflow` (`discover-local`) on the given cron, with
  `ScheduleOverlapPolicy.SKIP` so a slow run never overlaps the next tick.

**The gotcha:** because reconciliation happens once at startup, toggling the
schedule setting has no effect until the worker is restarted. Turning the
schedule on or off, or changing its cron, requires bouncing the worker.

Supervised contact research has **no schedule at all** — `ContactResearchWorkflow`
runs only when the user explicitly starts a run (there is no automation, and no
public source is auto-fetched by default; see the source-access policy in the
[domain model](../domain-model/tactical.md)).

## Discovery Run Progress

The Runs view progress bar is driven by the `progress` payload
(`_discovery_progress_payload` in `pipeline/runner.py`) that discovery
activities emit onto the `discovery_runs` aggregate. The denominator is fixed at
plan time: `progress_total = len(families) + 2` — one step per source family
plus a terminal enrichment and a terminal preparation step. The counter is
monotonic: family source activities advance it `0 … N-1`, then the terminal
reconcile enrichment (`N`) and preparation (`N+1 → N+2`, i.e. 100%) finalize it.

Under **score-as-you-discover streaming (R9 Phase 1)** the per-family enrichment
and preparation fan-out that run after each family are **progress-silent**: they
pass `progress_total=0`, which suppresses progress emission
(`emit_progress = progress_total > 0`), so the bar advances only on the family +
terminal spine and can never oscillate or shrink. Scores still appear
incrementally in the Jobs view because that path is independent of the progress
bar: `JobScored` events → projection builders → `GET /v1/events/stream`. Under
R9 Phase 2 (per-job handoff) those scores arrive at per-job granularity — a job
is scored the moment it is individually enriched — but the progress payload is
unchanged. No new `discovery_runs` progress columns are added, so both
projection builders stay in parity.

## Persistence Map

The Python worker writes to a single local SQLite database. Tables group by context;
the append-only `job_events` log plus the projection tables are the read-model
spine.

| Group | Representative tables |
| --- | --- |
| Discovery | `jobs`, source observations, `source_registry_entries`, source locator / manual-capture / review queue, quarantine, `discovery_runs`, `discovery_settings`, plus target search overlaid from `candidate_profiles` |
| Enrichment | enrichment fields / rows on jobs, posting content snapshots |
| Scoring | `job_scores`, `scoring_policies`, `job_score_staleness`, employer analysis |
| Materials | materials sets / tailored resumes, cover letters, rendered PDFs, `tailoring_policies` |
| Apply | apply stage state + apply lifecycle in `job_events` (see note) |
| Contact & Outreach | `contacts`, `contact_attributes`, `contact_research_tasks` (+ `source_attempts_json`), `contact_candidates`; projected into `contact_projections` + `contact_research_task_projections` |
| Orchestration / read model | `job_events` (append-only), `operational_attempt_metrics`, `job_stage_states`, `workflow_run_projections`, `job_list_projections`, `job_detail_projections`, `dashboard_projections`, artifact projections, `apply_run_projections` |
| Spend | `llm_spend` |
| Runtime | worker heartbeat / runtime identity |

Note: the legacy `apply_runs` / `apply_run_events` tables were dropped at boot.
Apply lifecycle now lives entirely in `job_events` and is projected into
`apply_run_projections`.

Operational metrics are append-only rows written at pipeline boundaries (stage,
source id, source role, adapter, attempt kind, outcome, counts, durations,
`error_class`, `error_message`, `run_id`, `job_url` when known) rather than
inferred from labels — so `discovery_runs.status='failed'` no longer has to carry
unrelated failure causes.

## Domain Events, Projections, and SSE

The authoritative event catalog is the TypeScript `DomainEventType` union in
`packages/domain-types/src/events/` — **68 event types**, guarded by an
exhaustiveness assertion and by the frontend's `every-event-has-handler` parity
test. The Python worker emits 55 of them through `create_domain_event` factories
in `workers/automation/src/jobctl/domain/events/`; the remaining types
(preparation work-item, resume-template, `TailorRetailorRequested`,
`TailoredArtifactsSuppressed`, `TailoringPolicyUpdated`,
`CompensationFactsUpdated`) originate on other code paths. Both sides fold the
same camelCase payloads, including the six `Workflow*` lifecycle events.

Three catalog corrections, because the old doc drifted:

- **There is no `CoverLetterFailed` event.** Cover success is
  `CoverLetterGenerated`; cover failure surfaces as `StageFailed` +
  `WorkflowFailed`.
- **`StageQueued` is not a typed domain event.** It is not in the 68-type union.
  The TS bulk routes tag reset/queued rows with a `StageQueued` marker string
  (`source: "bulk_retry_failed"` / `"bulk_run_pending_preparation"`), but it is
  not folded like a domain event.
- **`DiscoveryRunProgress` is not a domain event.** It is the heartbeat progress
  payload persisted onto the `discovery_runs` aggregate; the typed discovery-run
  events are `DiscoveryRunStarted` / `Completed` / `Failed`.

The read path is projection-backed, and there are **two projection builders**:
the Python `ProjectionBuilder` (in the worker, bus-subscribed and also refreshed
explicitly by finalize/reconciler) and the TypeScript `refreshProjections` (in
the API). Both rebuild the same projection tables from the same events.

```mermaid
flowchart LR
    Events[("job_events (append-only)")]
    Metrics[("operational_attempt_metrics")]
    Stages[("job_stage_states")]
    Agg[("aggregate tables")]
    PB["ProjectionBuilder (Python worker)"]
    RP["refreshProjections (TypeScript API)"]
    Proj[("projection tables<br/>job_list / job_detail / dashboard /<br/>artifacts / apply_run / workflow_run")]
    Api["TypeScript API read endpoints"]
    SSE["GET /v1/events/stream (250ms poll)"]
    UI["React + TanStack Query"]

    Events --> PB
    Events --> RP
    Metrics --> PB
    Stages --> PB
    Agg --> PB
    PB --> Proj
    RP --> Proj
    Proj --> Api
    Events --> SSE
    Api --> UI
    SSE --> UI

    classDef ui fill:#dbeafe,stroke:#2563eb,color:#0f172a
    classDef ts fill:#e0e7ff,stroke:#4f46e5,color:#1e1b4b
    classDef py fill:#d1fae5,stroke:#059669,color:#064e3b
    classDef store fill:#cffafe,stroke:#0891b2,color:#164e63
    class PB py
    class RP,Api,SSE ts
    class UI ui
    class Events,Metrics,Stages,Agg,Proj store
```

`job_list_projections.current_stage` is a *product-stage* field: builders write
only `discover` or `apply` there (the full internal stage list stays in
`job_detail_projections.stages_json`), with the `cover`→`apply` advance described
earlier. Note that `GET /v1/events/stream` is a **250 ms poller** over new
`job_events` rows, not a push stream — which is why a stage can complete a beat
before the UI card visibly changes: durable facts are recorded first, then
projections refresh and the next SSE tick invalidates the query cache. The SSE
contract is specified in [Local TypeScript API](../../local-ts-api.md).

### Projection Recovery

Read-model projections are rebuildable state; two recovery paths plus a
defensive dashboard read keep them truthful on existing databases:

- Both initialization paths — the Python worker and the TypeScript API —
  migrate legacy `workflow_run_projections` schemas before use, so older local
  databases cannot fail projection upserts mid-workflow.
- When workflow events were already watermarked but the Python-owned
  workflow-run projection table is missing rows, the projection is rebuilt
  from the event log instead of staying silently empty.
- Dashboard pipeline progress consults terminal workflow-run state, so a stale
  `StageStarted` row can no longer present a dead workflow as running.

## Failure Behavior Summary

- **Transient failures retry; preconditions fail fast.** Retryable errors retry
  up to each activity's attempt cap; `configuration`/`authentication`/
  `missing_input`/`budget_exceeded` never retry.
- **Discovery isolates sources.** One failed source family yields a partial
  result; the workflow fails only if a family fails after retries, and it fails
  with the source error, not a swallowed one.
- **Preparation isolates jobs.** A failed step fails only that job's workflow and
  resumes at the failed step; other jobs are unaffected.
- **Apply fails safe.** At-most-once + one live attempt + the CDP dry-run guard
  mean a failed or canceled apply never double-submits; cancellation is
  cooperative and terminalizes as `WorkflowCanceled`.
- **Nothing stays "running" forever.** Finalize records the terminal outcome on
  every normal/cancel path; the describe-based reconciler backstops killed
  workers, timeouts, and dev-server history loss.
