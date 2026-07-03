# Temporal-Native Rearchitecture

> **Status:** approved for implementation.
> **Source:** 2026-07-02 six-agent resilience audit (all findings file:line-verified)
> plus three read-only explorations (per-job runner readiness, apply internals,
> contract/ADR surface).
> **Style:** rip-and-replace per standing directive — each phase deletes the
> legacy path it replaces; no compatibility shims, no strangler branches.

## Context

Temporal was adopted (see
[`2026-05-07-temporal-and-worker-reliability-stack.md`](implemented/2026-05-07-temporal-and-worker-reliability-stack.md))
to make the pipeline durable and self-healing. The audit found it wired
correctly but architecturally sidelined:

1. **Whole-batch stage activities** wrap the legacy `run_pipeline()`; the
   durability/retry unit does not match the unit of work (one job × one stage).
2. **Errors are swallowed**: stage runners catch all exceptions and return
   `{"status": "error: ..."}` normally (`pipeline/runner.py:1717-1807`), so
   activity retry policies never fire for real failures — only for process
   death and timeouts.
3. **Workflow results are never consumed**: no `handle.result()` or
   `describe()` exists anywhere; failures at the Temporal layer write no
   `StageFailed` row and are invisible in-app.
4. **Recovery is trigger-coupled reapers** that mark work `failed (retryable)`
   for a manual retry click and never re-drive it: worker-restart sweep for
   stages/discovery runs (skips the live worker's own rows), next-discover-drain
   for preparation items, next-apply-batch unconditional lock rescue.
5. **Apply violates its documented at-most-once contract**
   (`docs/ddd-target.md:1162`): the unconditional running→pending rewind
   (`apply/launcher.py:1460`) plus post-submit-only durability makes
   double-submission to employers possible; dry-run is prompt-text-only under
   `--permission-mode bypassPermissions`; continuous mode dies silently at ~4h.
6. **Progress-blind heartbeats** (`run_in_activity.py`) detect process death
   only; stalls are bounded solely by `start_to_close` (6h discover / 30m
   stages / 2h apply) and timed-out shielded threads survive as zombies.
7. **No overlap control** (workflow IDs are `run-{uuid4}`), and the JSON-RPC
   path has no timeout at any layer with a strictly serial Python dispatch
   loop that lets one heavy sync handler head-of-line-block everything,
   including cancel.

This plan inverts the architecture: **Temporal becomes the single execution
authority** — per-job durable execution, raised-and-classified errors,
outcomes projected into the read model, engine-owned supervision and
scheduling, and an at-most-once apply path.

### Decisions (user-confirmed 2026-07-02)

- **D1 — Python-native boundary.** TS keeps JSON-RPC; no `@temporalio/*` in
  TS. The loop is closed by finalize activities (every workflow durably
  records its own outcome; Temporal re-delivers to the next worker after a
  crash) plus a thin describe-based reconciler in the worker heartbeat loop.
- **D2 — Apply safety with a user-configurable approval gate.** New settings
  flag `applyApprovalRequired` (default **TRUE**). ON: a live (non-dry-run)
  claim requires the latest `/apply-review` decision to be `approve_submit`,
  enforced inside the atomic claim (not the UI). OFF: one-click live apply.
  Unconditional regardless of the flag: deterministic `apply-{jobKey}`
  workflow IDs, durable submit-intent before the agent starts, evidence
  capture, `needs_verification` parking for ambiguous crashes (never
  auto-requeue after intent), browser-layer dry-run enforcement, continuous
  mode via continue-as-new.
- **D3 — Temporal Schedules capability, disabled by default**, overlap policy
  SKIP, settings surface to enable.
- **D4 — Single execution path.** CLI commands start workflows; in-process
  `run_pipeline` execution is deleted once workflows cover the surface.

## Target architecture

### Workflow taxonomy

All Python-native, deterministic IDs, start markers + finalize activities.

| Workflow | ID | Overlap | Body |
| --- | --- | --- | --- |
| `DiscoverWorkflow` | `discover-{tenant}` | `USE_EXISTING` | per-source-family activities (parallel where safe) + enrichment activity + fan-out of `JobPreparationWorkflow` children |
| `JobPreparationWorkflow` | `prep-{idempotency-key}` (reuses `make_preparation_idempotency_key`, `domain/preparation/work_items.py:116`) | `USE_EXISTING` | `score → tailor → cover → pdf` sequential activities for one job |
| `ApplyWorkflow` | `apply-{jobKey}` | `USE_EXISTING` | single intent-aware apply activity; browser-layer dry-run block; continue-as-new for continuous mode |
| `PipelineOrchestratorWorkflow` (today's `JobPipelineWorkflow`) | `run-{uuid}` | n/a | per requested stage, starts the right child workflow; preserves request order |
| `ProfileImportWorkflow` / `CompensationRefreshWorkflow` | `run-{uuid}` | n/a | replaces the two heavy sync RPC handlers |

The orchestrator shrinks each phase; `run_pipeline` (`pipeline/runner.py:2422`)
is deleted by P5.

### Event & projection model

- New **`Workflow*` event family** (6 types): `WorkflowStarted`,
  `WorkflowCompleted`, `WorkflowFailed`, `WorkflowCanceled`,
  `WorkflowTimedOut`, `WorkflowTerminated` — carrying `workflow_type`,
  `workflow_id`, input summary, and terminal status within the existing
  12-state `WORKFLOW_RUN_STATUSES` (`packages/contracts/src/schemas.ts:1650`).
- New **`workflow_run_projections`** table (Python-sole-writer, mirroring the
  `apply_run_projections` ownership pattern): PK `workflow_id`, cols
  `tenant_id, workflow_type, status, input_summary_json, error_code,
  error_message, retryable, started_at, finished_at, duration_ms,
  temporal_run_id, events_json`. Folded by a new `_rebuild_workflow_runs` in
  `infrastructure/projections/projection_builder.py` under the shared
  `operations_projections` watermark.
- `listWorkflowRuns` (`apps/api/src/read-model.ts:4819`) switches to
  `workflow_run_projections` (all types); `apply_run_projections` remains the
  apply-specific detail projection (two-level run header + apply body).
- **Deleted:** the overloaded `StageStarted`/`StageFailed` rows synthesized by
  the TS API (`apps/api/src/server.ts:2527/2546`); the write-only
  `discovery_run_projections` (P4).

### Recovery model (replaces all three reapers)

1. **Start marker + finalize.** Every workflow emits `WorkflowStarted` via an
   activity at the top and always runs a `record_workflow_outcome` finalize
   activity (try/except CancelledError/finally). Worker death → Temporal
   re-delivers → finalize runs on the next live worker. Terminal state is
   durable without a reaper.
2. **Reconciler** in `_worker_heartbeat_iteration` (`cli.py:1458`, 15s): open
   `workflow_run_projections` rows → `describe_workflow` → terminalize CLOSED
   or NOT_FOUND (dev-server data loss → `terminated`).

### Determinism constraints

Sandbox passes the whole `jobhunter` package through
(`infrastructure/temporal/worker.py:44`). New workflow logic keeps bodies
pure: job-set derivation for fan-out happens in activities returning
deterministic lists; no SQLite/clock/uuid/env reads at workflow scope;
continue-as-new for long loops.

### Cross-cutting decisions

- **CC1 IDs + overlap:** handlers set `WorkflowStartSpec.workflow_id` (seam at
  `domain/rpc/messages.py:115`); `default_workflow_starter`
  (`infrastructure/rpc/workflow_starter.py:45`) passes conflict/reuse
  policies. Double-click → `USE_EXISTING` returns the running handle.
- **CC2 Loop closure:** new `infrastructure/temporal/finalize.py`
  (`record_workflow_started` / `record_workflow_outcome`) reusing
  `record_job_event` + projection refresh.
- **CC3 Reconciler:** as above.
- **CC4 Registry lockstep:** the 6 new event types land in ONE PR across:
  `domain/events/__init__.py:116-178` + new `domain/events/workflow.py`; TS
  union + const array (`packages/domain-types/src/events/index.ts:298-425`) +
  new `./workflow` module; web handlers + `invalidation-router.ts` +
  `fixtures/events.ts`. `every-event-has-handler` and `AssertEnumExhaustive`
  are the tripwires.
- **CC5 Error taxonomy:** new `domain/errors.py`; non-retryable
  `ApplicationError` for config/auth/missing-input, retryable for transient
  network/browser/LLM-5xx. Activities raise; runners stop swallowing.
- **CC6 Cancellation + zombies:** thread `cancel_event` through all
  runners/sources (today JobSpy-only, `runner.py:1557`); every activity gets
  `on_cancel`; replace unbounded `asyncio.shield`
  (`run_in_activity.py:54`) with a bounded executor + cooperative deadline;
  abandoned threads are recorded, not silent.
- **CC7 Worker config:** `build_worker` gains `max_concurrent_activities` +
  dedicated `activity_executor` (bounds SQLite contention and zombies).

## Phases

Stacked PRs; each independently shippable in its own worktree; each runs the
pr-reviewer/fixer loop to `Gate: PASS` and the QA loop where UI/API/product
flows change; each deletes its legacy path.

### P0 — Visibility contract & loop closure · L · deps: none

**Goal:** execution becomes visible; results are consumed; deterministic IDs
give real no-overlap; finalize + reconciler make failures terminalize on
their own; the JSON-RPC/fetch hang is closed.

Work items:

- `Workflow*` event family across both registries + web handlers + fixtures
  (CC4).
- `infrastructure/temporal/finalize.py` + wiring into `JobPipelineWorkflow.run`
  (`pipeline/workflow.py:116`) and `ApplyWorkflow.run` (`apply/workflow.py:66`);
  register in `registry.py:30`.
- Deterministic IDs in `handlers.py` (`run_stage:203`, `apply_action:499`,
  `_pipeline_workflow_spec:434`) + policies in `workflow_starter.py:45`.
- `workflow_run_projections` DDL (mirror
  `infrastructure/projections/sqlite_projection_store.py:206`) +
  `_rebuild_workflow_runs`; mirror table creation in
  `apps/api/src/projections.ts:422` (TS reads only).
- Repoint `listWorkflowRuns` (`read-model.ts:4819`); add
  `GET /v1/workflow-runs/:runId` detail + `WorkflowRunDetail` contract; runs
  UI renders non-apply rows (badge set already 12-state).
- Reconciler pass in `cli.py:1458`.
- JSON-RPC per-request timeout (`apps/api/src/json-rpc-adapter.ts`); fetch
  `AbortController` (`packages/api-client/src/client.ts:652`); concurrent
  Python dispatch in `infrastructure/rpc/server.py:207` (responses under a
  stdout lock; confirm the TS adapter correlates by `id` — it does, via the
  pending map — before landing).
- Discover keeps `maximum_attempts=1` here; P0 delivers visible
  terminalization, P4 delivers automatic resumption.

Deletions: dead RPC handlers `reset_stage` / `mark_applied` / `mark_skipped` /
`cancel_stage` / `analyze_job` + their contract entries and the 5 stale legacy
result schemas (`packages/contracts/src/rpc.ts:359-410`); the TS overloaded
workflow rows (`server.ts:2527/2546`).

Tests: finalize emits terminal events on normal/exception/cancel paths;
ID-conflict returns the existing handle; reconciler terminalizes
CLOSED-but-running and NOT_FOUND; projection fold; parity tests. Fault
injection (headline): start discover → `kill -9` worker → restart → terminal
`workflow_run_projections` row visible in the runs UI.

QA gate: non-apply runs visible with correct badges; cancel records
`WorkflowCanceled`; a hung handler surfaces as a timeout, not a frozen tab.

Docs: `docs/architecture.md`, `docs/local-ts-api.md`, `docs/decisions.md`
(loop-closure + deterministic-IDs ADR).

### P1 — Error inversion & interruptibility · M–L · deps: P0

**Goal:** real failures reach Temporal's retry machinery; cancellation lands
everywhere; timeouts stop leaving silent zombies.

Work items: `domain/errors.py`; raise-on-failure in the six activity wrappers
(`scoring/activities.py:41`, `enrichment/activities.py`,
`materials/activities.py`, `discovery/activities.py`,
`profile/activities.py`); preserve `_run_stage_observed` observability
(`runner.py:319` — pipeline `Stage*` events, operational metrics, OTel spans)
as a hard invariant; per-stage retry-policy tuning; bounded executor +
cooperative deadline replacing `asyncio.shield` (`run_in_activity.py:34`);
`cancel_event` through `_run_discovery_source` (`runner.py:436`) and all
source adapters; score attempt cap (the `pending_score` selector,
`database.py:3505`, today uncapped → unbounded re-billing); LLM hardening
(5xx/connect retry, `Retry-After` cap + jitter — today slept uncapped,
`llm.py:392-406`).

Deletions: the swallow branches (`runner.py:1717-1807`); dead
`_RETRYABLE_STATUSES` (`enrichment/detail.py:298`) — wired, not deleted, if
trivially usable.

Tests: retryable vs non-retryable classification per activity; retry fires N
then surfaces; score cap honored. Fault injection: transient adapter error →
retry + recover; config error → fail fast with `WorkflowFailed`; cancel
mid-stage → executor exits within `cancel_wait`.

QA gate: broken enrich shows a failed workflow with a real cause; UI cancel
stops an in-flight stage promptly.

Docs: `docs/architecture.md` (error taxonomy + retry table),
`docs/local-reliability-qa.md`.

**Parallelization note:** the LLM-hardening + score-attempt-cap slice
(`llm.py`, `database.py:3505`) is file-disjoint from P0 and may ship as a
small standalone PR in parallel with P0 (P1a); the taxonomy/activity/cancel
work (P1b) stacks on P0.

### P2 — Apply safety (D2, configurable gate) · L, highest risk · deps: P0, P1 · ∥ P3

**Goal:** at-most-once apply; dry-run physically unable to submit; approvals
binding when enabled; evidence captured; policy user-configurable.

Work items:

- **Durable submit-intent.** Record intent durably in `ApplySaga.run`
  immediately before `submit_application` (`apply/process_manager.py:218`),
  replacing the no-op repository save (`:213`).
- **Intent-aware recovery** replaces `_rescue_orphaned_running_apply`
  (`launcher.py:1460`): crashed run WITH intent and unknown outcome → park as
  `needs_verification` in the apply-review queue, never auto-requeue; crashed
  run WITHOUT intent → safe rewind to pending. The P0 reconciler terminalizes
  the workflow row either way.
- **Configurable binding approval gate** — `applyApprovalRequired: boolean`,
  default **TRUE**, stored in `dashboard.json` next to `autoApply`, mirrored
  end-to-end:
  - contracts: `SettingsUpdateRequestSchema`
    (`packages/contracts/src/schemas.ts:1548-1559`) + `DashboardSettings`
    (`:2700-2716`);
  - API: `DEFAULT_SETTINGS` (`read-model.ts:98-106`), `normalizeSettings`
    (`:5054-5070`) via
    `normalizeBool(source.applyApprovalRequired ?? source.apply_approval_required, true)`,
    `writeSettingsConfig` (`write-model.ts:631-668`);
  - web: toggle cloned from the `autoApply` block
    (`settings-form.tsx:243-255`) with an OFF-state `role="alert"` warning;
    conditional affordances in `ApplyReviewView.tsx:994` +
    `JobActions.tsx:41-42`;
  - Python: read via a `criteria_provider.py:20-33` extension — fresh read
    per claim so a toggle takes effect on the next claim;
  - enforcement INSIDE the atomic claim: `approval_required` threaded like
    `min_score` through `ApplyActivityInput` (`apply/activities.py:19-36`) →
    `apply_main` → `acquire_job` (`launcher.py:181`); guard inside the
    `BEGIN IMMEDIATE` txn (`:288-343`): the latest
    `application_review_decisions` row for the job must be `approve_submit`,
    else rollback/skip. The backend is the gate; UI hiding is cosmetic.
- **Two required correctness fixes for the gate:** (F1) register
  `application_review_decisions` in `init_db` — today it is lazily created
  only by the gmail feedback path (`feedback.py:131`, DDL `:252-261`; add to
  the ensure block `database.py:233-253`); (F2) verify/repair that
  `approve_submit` decisions INSERT a real committed row (TS refs:
  `schemas.ts:233`, `application-feedback.ts:334`, `read-model.ts:1715`).
- **Browser-layer dry-run enforcement:** after Chrome launch, connect over
  CDP (`apply/chrome.py:214-247`), enable `Fetch` interception failing
  POST/PUT/PATCH to the application origin, and install
  `Page.addScriptToEvaluateOnNewDocument` overriding form submission — a
  prompt-injected agent under `bypassPermissions` still cannot submit.
- **Evidence capture:** persist `AgentResult.raw_output` + a
  confirmation-page snapshot as `job_artifacts`; derive
  `verification_confidence` from evidence instead of hardcoding 1.0
  (`claude_code_cli.py:362-364`).
- Deterministic `apply-{jobKey}` workflow IDs (CC1); continuous mode via
  continue-as-new (kills the silent ~4h death).
- Optional hardening: bind approval decisions to the reviewed artifact
  version so a re-tailor invalidates a stale approval.

Deletions: `_rescue_orphaned_running_apply` + the unconditional
`release_lock` rewind path (`launcher.py:1460/586`); `_NoopApplyRunRepository`
(`launcher.py:822`); dead `mark_orphans_as_failed` (`process_manager.py:354`).

Tests: gate ON blocks an unapproved live claim at the DB layer and admits an
approved one; gate OFF allows one-click live apply; kill-after-intent →
`needs_verification`, never re-acquired; kill-before-intent → safe rewind;
dry-run with a prompt-injected "submit anyway" instruction produces zero
POST/PUT/PATCH to the employer origin (CDP interception test); the approve
action commits a real decision row.

QA gate (Blocker-level): fresh install defaults ON; a direct backend call
(`api.applyJob`) with the gate ON leaves the job parked awaiting approval —
the UI-bypass check; OFF-state warning visible; evidence artifacts appear in
the run detail.

Docs: `README.md` (safety notes + new setting), `docs/architecture.md`,
`docs/local-reliability-qa.md` (apply regression matrix), `docs/decisions.md`
(at-most-once apply ADR).

### P3 — Per-job preparation workflows · L · deps: P0, P1 · ∥ P2

**Goal:** replace the pull-based claim/drain queue with
`JobPreparationWorkflow(id=prep-{idempotency-key})`; Temporal owns
retry/recovery for score/tailor/cover/pdf.

Design: `score → tailor → cover → pdf` as sequential activities in one
per-job workflow, reusing the self-contained cores: `score_job_by_url`
(`scorer.py:552`), `tailor_job_by_url` (`tailor.py:644`), a **new
`cover_letter_by_url`** (extracted from `run_cover_letters:157`, fixing the
single end-of-batch commit at `cover_letter.py:318` — per-job commit), and
wiring the idempotent, currently-zero-caller `RenderPdfUseCase`
(`use_cases.py:3533`) as the `pdf` step. Fan-out: discovery's finish and the
batch triggers derive the job set in an activity, then start
`JobPreparationWorkflow` children — the queue's `INSERT OR IGNORE`
idempotency semantics move into `USE_EXISTING` workflow IDs.

Deletions: the whole preparation queue —
`claim_next/complete/fail/retry/recover_running`
(`infrastructure/preparation/sqlite_repository.py`),
`_recover_stale_running_items` (`preparation.py:458`, **reaper #2**), the
drain call inside `finish_discovery` (`runner.py:1416`), and the
score/tailor/cover portion of **reaper #1**
(`recover_orphaned_running_stages`, `state.py:657`) since those stage rows
are now workflow-owned. `run_cover_letters` batch path deleted after
extraction.

Schema/contract: `JobPreparationWorkflow` registered (`registry.py`);
handlers `rescore_job/tailor_job/retailor_job` (`handlers.py:239/275/261`)
start it instead of `JobPipelineWorkflow`.

Tests: `cover_letter_by_url` commits per job (mid-batch crash keeps prior
jobs' stage-state); the workflow runs the 4 steps in order; idempotency-key
conflict returns the existing run. Fault injection: kill worker mid-`tailor`
→ restart → the prep workflow resumes at the failed step and completes; no
orphaned `running` prep rows remain (reaper #2 gone and unneeded).

QA gate: re-tailor from the UI produces the same artifacts idempotently; a
crashed cover-letter batch no longer loses stage-state for completed jobs.

Docs: `docs/job-pipeline-architecture.md` (preparation as per-job workflow),
`docs/architecture.md`.

### P4 — Discover decomposition + Schedules · L · deps: P3

**Goal:** `DiscoverWorkflow` with per-source-family activities; enrichment as
its own activity; prep fan-out as child workflows; real progress heartbeats;
cancel to all sources; the multi-source breaker fix; Temporal Schedules
(shipped disabled).

Design: `_run_discovery_source` (`runner.py:436`) already owns a full
`DiscoveryRun` aggregate lifecycle per family — that is the per-activity
seam. Families run parallel where safe (JobSpy/ATS/Workday/smart-extract).
Enrichment (`_run_discovery_enrichment_until_idle:2058`, per-job commits
retained, `detail.py:931`) becomes its own activity, site-batched internally.
`DiscoveryRunProgress` (`scheduler.py:90`, serializable frozen dataclass)
feeds real heartbeat payloads via `_record_discovery_source_progress`
(`runner.py:728`). Cancel wired to **all** sources (today JobSpy-only,
`runner.py:1557`). Breaker fix: `failed_source_id=""` for multi-source
families (`runner.py:545`) means JobSpy/Workday never trip quarantine
(`source_quality.py:181`) — attribute failures per real `source_id`.
Single-instance `discover-{tenant}` ID (CC1). Discover activities become
safely retryable (cancel isolates threads) → the **automatic-resumption**
half of the kill-worker demo lands here.

Deletions: the `run_pipeline` discover path (`_run_discover:1299`) and the
discover/enrich portion of **reaper #1** (`recover_orphaned_running_stages` +
`recover_orphaned_discovery_runs`, `state.py:657/838`, run at boot
`cli.py:1379` + every 15s `cli.py:1472`) — now fully removable; the
write-only `discovery_run_projections` table (zero readers).

Schema/contract: `DiscoverWorkflow` + per-source/enrich activities
registered; `run_stage discover` maps to it. Temporal Schedules API (overlap
policy `SKIP`) added, **disabled by default**, with a settings surface — no
scheduling setting exists today, so `scheduling_enabled` is net-new (home:
`discovery_settings.search_config_json`, read by both
`discovery-controls.ts` and Python).

Tests: each source family runs as an independent activity with its own
aggregate; cancel reaches Workday/ATS/smart-extract; multi-source failure
increments the correct `source_id`'s `consecutive_failures`; schedule
disabled ⇒ no auto-run. Fault injection (resumption proof): kill worker
mid-discover → restart → incomplete per-source activities are retried and
discovery finishes (not just terminalizes); reaper #1 deletion left no gap.

QA gate: discover cancels promptly across all sources; a repeatedly-failing
single source quarantines; the schedules toggle works and respects
overlap-skip.

Docs: `docs/job-pipeline-architecture.md` (discover decomposition +
sequence), `docs/architecture.md` (Schedules), `README.md` (scheduling
setting), `docs/decisions.md` (Schedules ADR).

### P5 — CLI cutover & governance · M · deps: P4

**Goal:** single execution path (D4) — CLI starts workflows; delete
in-process `run_pipeline`; add a spend ceiling; harden the fleet; rewrite
docs/ADRs.

Design: `jobhunter run` (`cli.py:685`), the stage commands
(`_run_stage_command`, `cli.py:507`), `run_single_job` (`runner.py:2642`),
and `run_local_action` (`actions.py:175`) all start workflows via the
Temporal client (worker+server required; `doctor` already probes
reachability, `cli.py:1677`). Spend ceiling: per-run budget input + global
daily counter checked in a preflight activity and enforced in finalize.
Convert the two remaining heavy sync RPC handlers (`refresh_compensation`,
`profile_import`) to workflows, removing the last HOL-blocking risk.

Deletions: in-process `run_pipeline` execution from `cli.py:507/685`,
`actions.py:175`, and the activity default paths that still wrap it
(`scoring/activities.py:81`, etc.) — activities call the per-job cores
directly; `run_pipeline`/`_run_pipeline_inner` (`runner.py:2422/2492`)
deleted once no caller remains (the `_run_stage_observed` observability moves
into the per-domain activities/workflows).

Tests: CLI command starts the expected workflow; spend cap blocks at
ceiling. Fault-injection suite (formalized): kill-worker→resume E2E per
workflow type; reconciler-wiring tests; adapter crash/hang tests; SSE resume
tests (250ms tail + Last-Event-ID, `event-stream.ts:268`) — added to
`docs/local-reliability-qa.md` as a fault-injection matrix.

QA gate: CLI with no worker fails clearly (not a half-run); spend cap
observed; full fault matrix green.

Docs: `README.md` (CLI now needs worker),
`docs/architecture.md`/`docs/job-pipeline-architecture.md` full rewrite of
the execution model, `docs/decisions.md` (supersede/amend affected ADRs;
reconcile the `ddd-target.md` §6.5 vs §5.7 contradiction — resolved truth is
Python-native dispatch behind JSON-RPC), `workers/automation/pyproject.toml`
if deps change.

## Reaper deletion schedule

| Reaper | File:line | Deleted in | Replaced by |
| --- | --- | --- | --- |
| #3 apply lock rescue (unconditional running→pending) | `launcher.py:1460` → `release_lock:586` | **P2** | intent-aware recovery + `needs_verification` + reconciler |
| #2 preparation drain recovery (`recover_running`) | `preparation.py:458`; drain at `runner.py:1416` | **P3** | `JobPreparationWorkflow` (Temporal retry) |
| #1 orphaned-stage/discovery sweep (boot + 15s) | `state.py:657/838`; `cli.py:1379/1472` | score/tailor/cover part **P3**; discover/enrich part **P4** (fully removed) | per-job/discover workflows own running-state; finalize + reconciler terminalize |

## Risk register

1. **Workflow-ID collision vs double-click UX.** `USE_EXISTING` makes a
   double-click return the running handle (idempotent) rather than
   erroring/duplicating. Mitigation: TS dispatch surfaces "already running,
   attached" cleanly; return the existing `runId`.
2. **Sandbox determinism as workflows grow logic.** Whole-`jobhunter`
   passthrough (`worker.py:44`) lets workflow code import non-deterministic
   modules. Mitigation: job-set derivation only in activities; determinism
   unit tests; keep workflow bodies pure.
3. **Per-job fan-out volume vs local dev-server limits.** Hundreds of
   `JobPreparationWorkflow` children. Mitigation: child-workflow batching +
   continue-as-new; bounded `max_concurrent_activities` (CC7).
4. **SQLite write contention under concurrent activities.** WAL +
   `busy_timeout` help but many parallel writers thrash. Mitigation: bound
   activity concurrency; keep per-item commits; derive-from-canonical
   projections self-heal via watermark.
5. **Dual-projection drift** (Python builder vs `projections.ts`,
   required-equivalent per ADR `decisions.md:241`). `workflow_run_projections`
   is Python-sole-writer (matching `apply_run_projections`) — TS reads only.
   Mitigation: parity fixture test that both sides read identical rows;
   single shared watermark.
6. **Temporal dev-server data loss** (no durable history across restarts). A
   workflow can vanish. Mitigation: reconciler treats NOT_FOUND as terminal
   (`terminated`); QA documents dev-server semantics.
7. **In-flight state at cutover.** Jobs mid-run when a phase ships.
   Mitigation: each phase drains/terminalizes in-flight legacy work before
   its reaper is deleted; deploy phases on a quiet worker; reconciler
   backstops.
8. **Registry lockstep breakage** (61→67 event types). If TS or Python lags,
   `every-event-has-handler` / `AssertEnumExhaustive` break the build.
   Mitigation: single-PR dual-registry edits (CC4); the parity tests are the
   intended tripwire, not a hazard.
9. **D2 settings write is a file write** (`dashboard.json`), not
   transactional with SQLite — acceptable for a rarely-changed policy flag.
   Mitigation: fresh per-claim read means a toggle takes effect on the next
   claim; the decision-row SELECT stays inside the claim txn, so the approval
   check itself is race-safe.

## Verification

Per surface: Python
`uv --project workers/automation run --extra dev pytest -q` +
`ruff check .`; API `pnpm api:check` + `pnpm api:test`; web `pnpm web:check`
+ `pnpm --filter @jobhunter/web test` + `test-d` + `e2e`; parity tests
(`every-event-has-handler`, `every-stage-state-has-badge`) on every
event-touching PR; `pnpm test` full sweep before each phase merge.

**The kill-worker demo that proves the original complaint is fixed** (run at
P0, extended at P4):

1. `pnpm dev` (Temporal + API + web + worker).
2. Trigger discover from the UI.
3. `kill -9` the worker process mid-discover.
4. Restart the worker.
5. **P0 assertion:** within one reconciler tick, the runs UI shows the
   workflow terminalized (a real terminal `workflow_run_projections` row +
   `Workflow*` event) — no silent death; the failure is visible in-app.
6. **P4 assertion:** the incomplete per-source activities are retried and
   discovery *resumes to completion* automatically.

Together these convert the root problem ("Temporal is wired but sidelined;
failures invisible; recovery is trigger-coupled reapers") into "Temporal owns
execution, visibility, and recovery."

## Execution order & parallelism

P0 is the gating spine — first, alone (P1a may run alongside it: file-disjoint
LLM hardening + score cap). Then P1b (stacked on P0). Once P0+P1 land, **P2
(apply safety) and P3 (preparation) run in parallel** — disjoint surfaces
(apply vs score/tailor/cover). P4 depends on P3; P5 depends on P4.

Critical path: **P0 → P1 → {P2 ∥ P3} → P4 → P5.**
