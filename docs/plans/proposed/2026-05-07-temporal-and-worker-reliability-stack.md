# Temporal + Worker Reliability Stack

> **Status:** proposed.
> **Source:** `docs/backlog.md` → "Workflow Orchestration (Local Temporal)"
> and the surrounding "Worker Reliability" items.
> **Style:** rip-and-replace per `MEMORY.md` — each PR removes the legacy
> code path it supersedes; no compatibility shims.

## Goal

Adopt **local Temporal** as the orchestration engine for the Python worker
and the local TypeScript API, then complete the remaining Worker Reliability
items in the same stack. Each PR is independently shippable, sits on top of
the previous PR's branch, and follows JobHunter's PR review loop in
`AGENTS.md`.

## Stack

### PR 1 — Local Temporal foundation (worker bootstrap)

Branch: `temporal/foundation` off `main`.

- Add `temporalio` to `workers/automation/pyproject.toml`.
- Add a Temporal `dev server` lane to local development — preferred path is
  documenting `temporal server start-dev` in `docs/local-development.md`
  with a one-line check in `jobhunter doctor`. No docker-compose required
  for the local-only profile.
- New module `workers/automation/src/jobhunter/infrastructure/temporal/`
  with `client.py` (client factory), `worker.py` (Worker bootstrap that
  loads workflow + activity registries), and `task_queues.py` (single
  `JOBHUNTER_TASK_QUEUE` constant).
- New CLI command `jobhunter worker` that boots a long-lived Worker
  bound to `JOBHUNTER_TASK_QUEUE`.
- Health check in `jobhunter doctor` — `Temporal: reachable` /
  `unreachable (start with: temporal server start-dev)`.
- No workflows/activities yet beyond a registration-test smoke
  workflow used to verify the worker boots in the unit tests. The
  smoke workflow is *not* registered in production wiring.
- Tests: pytest covers (a) client factory honouring `TEMPORAL_ADDRESS`
  env, (b) worker boot loads the (empty) registry without errors,
  (c) the doctor command surfaces both reachable + unreachable states.
- Docs: `README.md` Requirements section gains "Temporal dev server
  (`temporal server start-dev`) for the workflow engine"; the
  Architecture doc gets a new "Workflow Orchestration (Local
  Temporal)" subsection summarising the client + worker shape.

Out of scope: any pipeline activities, any `JobPipelineWorkflow`, any
JSON-RPC change. Apply / `apply_runs` untouched.

QA: skipped — automation-only, no UI/UX surfaces touched.

### PR 2 — Pipeline activities + JobPipelineWorkflow

Branch: `temporal/pipeline-workflow` off `temporal/foundation`.

- One activities module per bounded context:
  - `workers/automation/src/jobhunter/discovery/activities.py`
  - `enrichment/activities.py`
  - `scoring/activities.py`
  - `materials/activities.py` (tailor, cover, pdf each)
  - `apply/activities.py`
  - `profile/activities.py` (the existing `profile_import` action)
- Each activity wraps an existing stage runner and stays a thin
  adapter — no business logic moves into the activity body. The
  activity passes `tenantId` + `jobUrl` through and lets the existing
  per-stage runner keep its current ports.
- New `JobPipelineWorkflow` at
  `workers/automation/src/jobhunter/pipeline/workflow.py` (one per
  `(TenantId, batch-of-stages)`) orchestrates the **non-apply** stages in
  batch mode against eligible jobs in the local DB. Stage eligibility is
  owned by the underlying runner via `state.set_stage_state`, not by the
  workflow. `ApplyWorkflow` (one per `(TenantId, JobId)`) drives apply
  per-job. Per-`(TenantId, JobId)` batching for non-apply stages is
  deferred until the underlying runners accept a `job_url` parameter —
  tracked in [`docs/backlog.md`](../../backlog.md) under "Worker
  Reliability".
- New `ApplyWorkflow` at `apply/workflow.py` — handles the long-lived
  apply-automation flow with cooperative cancellation. The activity
  re-raises transient failures so the workflow's `max_attempts=2` retry
  policy fires; `LookupError` is wrapped in a non-retryable
  `ApplicationError`.
- Worker registry from PR 1 now binds these activities + workflows.
- Tests: pytest using `temporalio.testing.WorkflowEnvironment` for
  (a) per-activity happy path (e.g. `score_activity` writes a
  `JobScore` via the existing repository), (b) `JobPipelineWorkflow`
  drives `discover→enrich→score` in order, (c) workflow cancellation
  cancels the activity cooperatively, (d) unknown stage names surface
  as a non-retryable `ApplicationError`, (e) passing `"apply"` is
  rejected with a pointer to `ApplyWorkflow`.

Out of scope: replacing the JSON-RPC `fire_and_forget` path; the
apply-runs table; UI changes.

QA: skipped — automation-only.

### PR 3 — Cut over JSON-RPC to workflows

Branch: `temporal/jsonrpc-cutover` off `temporal/pipeline-workflow`.

- Delete the `fire_and_forget` mode in
  `workers/automation/src/jobhunter/infrastructure/rpc/server.py`
  (the `threading.Thread` shortcut on lines 87–97). Replace it with a
  `workflow` dispatch mode where the handler returns a
  `WorkflowStartSpec(workflow, args, workflow_id?, retry_policy?)`
  and the server starts the workflow via an injected `WorkflowStarter`
  (default: `get_temporal_client().start_workflow(...)`) and returns
  `{ "runId": ..., "workflowId": ..., "firstExecutionRunId": ... }`
  (preserving the existing `runId` field name in the response so the
  TS contract stays the same).
- Re-register `apply` as `mode="workflow"` mapping to
  `ApplyWorkflow`.
- **Scope narrowed:** `run_stage` and `profile_import` stay
  `mode="sync"` for now. They are sync today and the TS callers
  expect synchronous result shapes (e.g. `defaultProfileImporter`
  extracts a profile draft from the response). Converting them
  changes existing sync contracts and deserves its own follow-up —
  in PR 3, only `apply` flips to `workflow` mode.
- TS `apps/api/src/local-actions.ts` keeps its `{ runId }` shape and
  the existing `status: "queued"` translation — the comment about
  `fire_and_forget` becomes "workflow start — server returns
  `{ runId }` (the Temporal workflow id)".
- New JSON-RPC method `cancel_run` (`mode=sync`) that takes a
  `runId` (workflow id) and calls
  `client.get_workflow_handle(run_id).cancel()` so the existing TS
  cancel surface (`cancelJobAction`) works against in-flight
  workflows. The current `cancel_stage` handler stays as the
  post-hoc state-flip; `cancel_run` is the cooperative path.
- Tests: (a) `apply` via JSON-RPC starts a workflow and returns a
  workflow id, (b) `cancel_run` propagates to a running workflow,
  (c) the deleted `fire_and_forget` path is gone — assert the mode
  is no longer accepted by `JsonRpcServer.register`.

Out of scope: collapsing the `apply_runs` table into workflow runs;
UI surfaces; converting `run_stage` / `profile_import` to workflows
(deferred to a follow-up — see scope narrowing above).

QA: skipped — automation-only at the wire level. Existing TS `{ runId }`
contract is preserved, so the UI continues to function unchanged.

### PR 4 — Collapse `apply_runs` into workflow runs

Branch: `temporal/apply-runs-collapse` off `temporal/jsonrpc-cutover`.

Shipped via Approach A (event-driven projection). The launcher and
`SubmitApplicationUseCase` already publish `ApplyRunStarted` /
`ApplicationSubmitted` / `ApplicationFailed` / `DryRunCompleted` events
through `record_job_event`; the Python `ProjectionBuilder` now derives
`apply_run_projections` rows directly from `job_events` keyed by
`payload.run_id`. The workflow-history poller (Approach B) was not
needed.

- Delete the bespoke `apply_runs` table writes (drop
  `SqliteApplyRunRepository` entirely). The launcher's queue locks
  move to `job_stage_states.apply.state`; lifecycle events feed
  `apply_run_projections` directly.
- Extend `ProjectionBuilder._rebuild_apply_runs` to source the
  projection rows from `job_events` (no second poller). The TS
  read-model keeps reading `apply_run_projections`.
- TS `apps/api/src/projections.ts` deletes the
  `apply_runs → apply_run_projections` projector (Python now owns it)
  and reads `apply_run_projections` directly via `loadLatestApplyRun`
  / `recentApplyRuns`.
- Migration: drop the `apply_runs` + `apply_run_events` tables in a
  single SQL block added to `workers/automation/src/jobhunter/database.py`
  (single
  user, no data preservation requirement — but call this out
  explicitly in the PR description so the user knows their existing
  apply-run history is wiped).
- Tests: (a) workflow completion produces the expected
  `apply_run_projections` row, (b) workflow failure produces the
  `failed` row with the failure cause from workflow history,
  (c) projection rebuild from history is deterministic.

Out of scope: UI Workflow Runs view.

QA: skipped — read-model contract preserved; the UI continues to render
the same shape.

### PR 5 — Workflow Runs view in UI

Branch: `temporal/runs-view` off `temporal/apply-runs-collapse`.

- New page at `apps/web/src/views/runs/RunsView.tsx` that lists
  in-progress / failed / completed workflow runs from the existing
  `apply_run_projections` (now sourced from workflow histories) plus
  any non-apply workflow runs the projector exposes.
- Deep-link button on each row: "Open in Temporal Web UI"
  (`http://127.0.0.1:8233/namespaces/default/workflows/<workflowId>`)
  for live debugging.
- Reuses existing `ApplyRunBadge` / `ApplyRunTimeline` components
  from `apps/web/src/contexts/apply/`; new `<RunStatusBadge>` for
  the wider workflow-run states (running / completed / failed /
  canceled / terminated / timed-out).
- Operations hook: `useWorkflowRunsListQuery` in
  `apps/web/src/contexts/operations/hooks/`.
- Invalidation handler: extend
  `apps/web/src/contexts/operations/invalidation-router.ts` so
  workflow-run lifecycle events from the SSE stream invalidate the runs
  list. Implementation note: the worker does not yet emit dedicated
  `WorkflowStarted` / `WorkflowCompleted` / `WorkflowFailed` /
  `WorkflowCanceled` event types; the existing apply-run lifecycle
  events (`ApplyRunStarted` / `ApplicationSubmitted` /
  `ApplicationFailed`) drive the same invalidation by also targeting
  `workflowRunsKeys.lists` and `workflowRunsKeys.detail`. When the
  worker grows non-apply workflows, add the `Workflow*` event types and
  route them through the same `workflowRunsKeys` factory.
- Backend surface: `GET /v1/workflow-runs` (paginated; `status` filter,
  with `WorkflowRunStatus` widening beyond `ApplyRunStatus` to include
  `canceled` / `terminated` / `timed_out`). Schema:
  `WorkflowRunSummary` exposes both `runId` and `workflowId` as
  distinct fields — today they are equal (the Python `ApplyWorkflow`
  uses `info.workflow_id` as the timeline key); the seam is preserved
  so future non-apply workflows that separate the two land without a
  breaking read-model change.
- Out-of-scope follow-up: the JSON-RPC `cancel_run` handler +
  `CancelRunParamsSchema` already exist (PR 3 fixer). Wiring an
  in-row "Cancel running workflow" UI button is a follow-up.
- Tests: hook test + view component test + a Playwright spec covering
  list → "Open in Temporal Web UI" link presence (correct `href` and
  `target="_blank"`).

QA: **required** for this PR — UI surface change, new page, new
invalidation routing. Run the full PR review/fix + QA loop per
`AGENTS.md`.

### PR 6 — Worker Reliability: collapse the second stage-state write path

Branch: `worker-reliability/single-stage-state-writer` off
`temporal/runs-view`.

- Delete the ad-hoc `UPDATE/INSERT INTO job_stage_states` blocks at
  `workers/automation/src/jobhunter/infrastructure/pipeline/sqlite_repository.py:249,296`.
- Route both call sites through `state.set_stage_state` so the
  validation + event emission in the canonical helper apply.
- Tests: pytest asserts that `JobPipelineRepository.save` emits the
  same `JobStageEntered` / `JobStageExited` events the canonical
  helper emits, and the same per-stage `attempts` math holds.

QA: skipped — automation-only.

### PR 7 — Worker Reliability: register logs + reports as artifacts

Branch: `worker-reliability/logs-as-artifacts` off
`worker-reliability/single-stage-state-writer`.

- Wire `state.record_job_artifact` (currently dead-code per the
  backlog) into the apply / materials / scoring writers so the log
  files and report files they produce show up in the artifacts list.
- Drop the `apply_runs.log_path` string field from the workflow-runs
  projector (PR 4) — log paths now live in `job_artifacts`.
- TS read-model: `artifact_list_projections` automatically picks
  these up via the existing projection.
- Tests: a successful apply run produces an artifact row of kind
  `apply_log`; a successful score run produces an artifact row of
  kind `score_report`; UI integration coverage stays at the
  read-model boundary (no new UI in this PR).

QA: skipped — automation-only writer changes; artifacts list is
already fully tested.

## Sequencing rules

- Each PR creates its own worktree off the previous branch.
- The parent agent (this Claude) owns orchestration: spawn
  `pr-feature-implementer` per PR, run the `pr-reviewer` /
  `pr-fixer` loop up to 3 iterations, then spawn `qa` only for
  PR 5 (the UI-touching PR).
- Stop and re-plan if any PR hits Blocker / High after 3 fixer
  attempts.
- `main` stays clean — no edits land on `main` from this stack.

## Verification command set (per PR)

- Python: `uv --project workers/automation run --extra dev pytest -q`
  and `uv --project workers/automation run --extra dev ruff check .`.
- TS API: `pnpm api:check && pnpm api:test`.
- Web (PR 5 only): `pnpm web:check && pnpm web:test &&
  pnpm web:test-d && pnpm --filter @jobhunter/web e2e`.
- `git diff --check` on every commit.
