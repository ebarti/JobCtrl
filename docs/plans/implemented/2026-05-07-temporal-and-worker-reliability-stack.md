# Temporal + Worker Reliability Stack

> **Status:** implemented.
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

- Wire `state.record_job_artifact` (previously dead-code per the
  backlog) into `apply.launcher.mark_result` so the per-worker agent
  log file (`LOG_DIR/worker-{worker_id}.log`, written by
  `ClaudeCodeCliAdapter`) shows up as a `job_artifacts` row of kind
  `apply_log` in the same transaction as the terminal
  `ApplicationSubmitted` / `ApplicationFailed` / `DryRunCompleted`
  event. The UPSERT key on `(job_url, stage, artifact_type, path)`
  keeps the call idempotent across the worker's job sequence.
- Producer survey for the rest of the pipeline:
  - `scoring.scorer` writes no files — reasoning lives in `job_scores`
    only. No artifact to register; deferred to a follow-up if/when the
    scorer starts emitting an on-disk report.
  - `scoring.tailor`, `scoring.cover_letter`, and the
    `LatexPdfAdapter` / `PlaywrightHtmlPdfAdapter` PDF renderers
    already register their primary outputs (resume `.txt`, cover
    letter `.txt`, resume PDF, cover letter PDF) through
    `SqliteMaterialsRepository` into `job_materials_artifacts`, which
    `ProjectionBuilder._load_artifacts` already merges into
    `artifact_list_projections`. No additional wiring needed.
- TS read-model: `artifact_list_projections` automatically picks the
  new `apply_log` rows up via the existing projection — no schema
  change.
- Tests: per-writer coverage in
  `tests/test_apply_log_artifact_registration.py` —
  `mark_result(applied)`, `mark_result(failed)`, and
  `mark_result(dry_run)` each record an `apply_log` artifact (and the
  `applied` test refreshes the projection and asserts the row appears
  in `artifact_list_projections`); a manual `mark_result` without a
  `worker_id` does NOT fabricate an artifact; two consecutive runs
  from the same worker UPSERT to a single row whose `size_bytes`
  reflects the appended file.

Out of scope:
- `score_report` registration — scoring is in-memory + DB only today;
  introducing on-disk reports just to register them is a behaviour
  change that exceeds this PR.
- Auxiliary tailor side-files (`{prefix}_REPORT.json`,
  `{prefix}_JOB.txt`) and the LaTeX `.tex` source emitted next to the
  resume PDF — primary tailored materials are already registered;
  surfacing the auxiliaries would require a new artifact kind.
- Vestigial `apply_runs.log_path` cleanup — already done in PR 4 (the
  table is dropped).
- `DryRunComplete` event addition (Frontend Tooling backlog).

QA: skipped — automation-only writer changes; artifacts list is
already fully tested.

### PR 8 — Langfuse observability via OpenTelemetry

Branch: `observability/langfuse-otel` off
`worker-reliability/logs-as-artifacts`.

- Add OpenTelemetry to `workers/automation/pyproject.toml`:
  `opentelemetry-api`, `opentelemetry-sdk`,
  `opentelemetry-exporter-otlp-proto-http`, plus the optional
  `opentelemetry-instrumentation-httpx` for auto-instrumented LLM HTTP calls.
- New module
  `workers/automation/src/jobhunter/infrastructure/observability/`:
  - `otel.py` — `init_otel(*, service_name, environment)`, `shutdown_otel()`,
    and `is_otel_enabled()`. Reads `LANGFUSE_PUBLIC_KEY` /
    `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL` from `os.environ`,
    builds an `OTLPSpanExporter` pointed at
    `${LANGFUSE_BASE_URL}/api/public/otel/v1/traces` with
    `Authorization: Basic <base64(pk:sk)>` and the
    `x-langfuse-ingestion-version: 4` fast-preview header, wraps it in
    a `BatchSpanProcessor`, and sets the global `TracerProvider`.
    Idempotent. Degrades gracefully when env vars are missing.
    Honours `LANGFUSE_DISABLE=1` as an explicit opt-out even when
    credentials are present.
  - `llm_spans.py` — `llm_generation_span(model, messages, params)`
    context manager that opens a `langfuse.observation.type=generation`
    span, sets the Langfuse-specific attributes
    (`langfuse.observation.model.name`,
    `langfuse.observation.model.parameters`,
    `langfuse.observation.input`, `langfuse.observation.output`,
    `langfuse.observation.usage_details`) plus the GenAI semantic
    conventions (`gen_ai.request.model`, `gen_ai.response.model`,
    `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`).
- Wiring:
  - `jobhunter.llm.LLMClient.chat` (both compat + native Gemini paths)
    now wraps each call in `llm_generation_span`, extracting token
    counts from the OpenAI-compat `usage` object and the native
    Gemini `usageMetadata`.
  - `jobhunter.infrastructure.temporal.client.get_temporal_client` now
    constructs the `Client` with
    `interceptors=[TracingInterceptor()]`.
  - `jobhunter.infrastructure.temporal.worker.build_worker` now passes
    the same `TracingInterceptor` into the `Worker` so workflow +
    activity spans flow automatically with trace context preserved
    across the workflow start.
  - `jobhunter.infrastructure.rpc.server.JsonRpcServer.dispatch` now
    opens a `rpc.<method>` span with `langfuse.trace.name=<method>`,
    `langfuse.observation.type="span"`, `rpc.method`, and `rpc.id`
    attributes; handler exceptions mark the span ERROR.
  - `jobhunter.cli._bootstrap()` calls `init_otel()`, so every CLI
    command configures exporting on startup. The `worker` command
    calls `shutdown_otel()` in a `finally` so the
    `BatchSpanProcessor` flushes on Ctrl-C.
- `jobhunter doctor` gains a `Langfuse` row that probes the OTLP
  endpoint with a 2 s `httpx.head` and reports
  `OK reachable` / `MISSING (set LANGFUSE_*…)` / `unreachable`.
- Tests: `test_otel_init.py` (idempotency, missing-creds graceful
  degradation, `LANGFUSE_DISABLE` opt-out, payload-export warning,
  endpoint + auth header shape), `test_llm_spans.py` (Langfuse span
  attributes, unknown-token handling, exception status), `test_rpc_otel.py`
  (dispatch span attributes + error status), `test_doctor_langfuse.py`
  (reachable / missing / unreachable code paths).
- Docs: `docs/architecture.md` gains an "Observability" section under
  `Runtime Boundaries`. `README.md` `Configuration` section grows the
  `LANGFUSE_*` env-var entry. `AGENTS.md` `Reference Index` and
  `Documentation Requirements` table both gain an Observability row.

Out of scope: TS/web instrumentation (`apps/api`, `apps/web`,
`packages/`), distributed-trace propagation across the TS↔Python
JSON-RPC boundary, dashboards / alerts / SLOs in Langfuse UI,
prompt-versioning via Langfuse prompts, cost calculation overrides
(Langfuse computes cost from token counts via its model registry).

QA: skipped — automation/observability only.

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
