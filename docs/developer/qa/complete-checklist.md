# Complete Reliability & QA Checklist

This is the QA checklist and regression map for local changes: the commands to
run, the Temporal fault-injection matrix, the high-risk regression matrix that
pairs each risk with its automated coverage, the scoring and tailoring eval
gates, and the frontend QA pyramid.

Read the relevant section when the QA router identifies one of these risks.

Jump to the [regression matrix](#high-risk-regression-areas) for the risk →
coverage table, or the
[Temporal fault-injection matrix](#temporal-fault-injection-matrix) for
per-workflow failure behavior. The known-failing web e2e baseline these gates
run against is recorded in the [backlog](../../backlog.md).

## Selecting Checks

Use [Reliability & QA](../../local-reliability-qa.md) to choose the smallest
applicable proof. This catalog is read by relevant section; it does not require
all suites for every change. Run worker-backed smoke only on a healthy isolated
stack, using `corepack pnpm dev` when the full stack is needed.

## Temporal Fault-Injection Matrix

| Workflow type | Kill worker mid-activity | Cancel request | Temporal unreachable at start | Dev-server history wipe |
| --- | --- | --- | --- | --- |
| `DiscoverWorkflow` | Auto-resumes source-family or enrichment activity under Temporal retry; broad-board coverage kills the worker after accepted-job commit but before JobStreaming acknowledgement and resumes on a fresh worker in `workers/automation/tests/test_jobstreaming_resumable_discovery.py`; general coverage lives in `workers/automation/tests/test_workflow_discovery.py`. | Prompt stop propagates to source-family cancel events and terminalizes discovery progress; JobStreaming waits and unit state are covered by `workers/automation/tests/test_jobstreaming_resumable_discovery.py`, with all-family propagation in `workers/automation/tests/test_p1b_error_inversion.py`. | CLI/API return a clear workflow-start error with no in-process fallback; covered by `workers/automation/tests/test_actions.py` and `workers/automation/tests/test_jsonrpc_handlers.py`. | Reconciler marks lost open runs terminal with `WorkflowTerminated`; covered by `workers/automation/tests/test_workflow_finalize.py`. |
| `JobPipelineWorkflow` | Auto-resumes at the failed activity or child workflow; covered by `workers/automation/tests/test_workflow_job_pipeline.py`. | Prompt stop records workflow cancellation and leaves completed stage facts durable; covered by `workers/automation/tests/test_workflow_finalize.py`. | CLI/API return a clear workflow-start error with no in-process fallback; covered by `workers/automation/tests/test_actions.py`. | Reconciler terminalizes orphaned open workflow rows; covered by `workers/automation/tests/test_workflow_finalize.py`. |
| `JobPreparationWorkflow` | Auto-resumes the current per-job score/tailor/cover/PDF step; covered by `workers/automation/tests/test_workflow_job_preparation.py`. | Prompt stop records workflow cancellation without deleting accepted artifacts; covered by `workers/automation/tests/test_workflow_finalize.py`. | API retry/current-policy dispatch returns workflow-start failure and does not run synchronously; covered by `workers/automation/tests/test_jsonrpc_handlers.py`. | Reconciler terminalizes open prep workflows after history loss; covered by `workers/automation/tests/test_workflow_finalize.py`. |
| `ApplyWorkflow` | Model-driven browser final submit fails closed before prompt/browser/agent; owned email submit intent terminalizes or parks for verification instead of blind retry; dry-run retries are bounded; covered by `workers/automation/tests/test_apply_use_cases.py`, `workers/automation/tests/test_apply_saga.py`, `workers/automation/tests/test_claude_code_cli_adapter.py`, `workers/automation/tests/test_workflow_apply.py`, and `workers/automation/tests/test_apply_regressions.py`. | Prompt stop cancels the workflow and persists apply-run cancellation evidence; covered by `workers/automation/tests/test_workflow_apply.py`. | CLI/API return a clear workflow-start error with no browser execution; covered by `workers/automation/tests/test_actions.py` and `workers/automation/tests/test_rpc_handlers_apply_workflow.py`. | Reconciler terminalizes the workflow row while apply events remain inspectable; covered by `workers/automation/tests/test_workflow_finalize.py`. |
| `ProfileImportWorkflow` | Auto-resumes or terminalizes the single import activity through Temporal retry/finalize; covered by `workers/automation/tests/test_workflow_heavy_rpc_conversions.py`. | Prompt stop records workflow cancellation; manual QA can cancel the run from `/runs` while importing a synthetic PDF. | JSON-RPC and local action surfaces return workflow-start failure without running profile import inline; covered by `workers/automation/tests/test_jsonrpc_handlers.py` and `workers/automation/tests/test_actions.py`. | Reconciler terminalizes open profile-import workflows; covered by `workers/automation/tests/test_workflow_finalize.py`. |
| `CompensationRefreshWorkflow` | Auto-resumes or terminalizes the single refresh activity through Temporal retry/finalize; covered by `workers/automation/tests/test_workflow_heavy_rpc_conversions.py`. | Prompt stop records workflow cancellation; manual QA can cancel the run from `/runs` while refreshing synthetic compensation fixtures. | JSON-RPC and CLI surfaces return workflow-start failure without refreshing compensation inline; covered by `workers/automation/tests/test_jsonrpc_handlers.py` and `workers/automation/tests/test_compensation_refresh_cli.py`. | Reconciler terminalizes open compensation-refresh workflows; covered by `workers/automation/tests/test_workflow_finalize.py`. |
| `InterviewPrepWorkflow` | Auto-resumes or terminalizes the single stored-prep activity through Temporal retry/finalize; covered by `workers/automation/tests/test_interview_prep_generation.py` and `workers/automation/tests/test_jsonrpc_handlers.py`. | Prompt stop records workflow cancellation without deleting the last accepted prep generation; manual QA can cancel the run from `/runs` once the UI trigger lands. | JSON-RPC starts only `generate_interview_prep` as workflow-mode stored preparation and exposes no live-assistance surface; covered by `workers/automation/tests/test_jsonrpc_handlers.py` and `apps/api/test/rpc-contracts.test.ts`. | Reconciler terminalizes open interview-prep workflows through the shared workflow lifecycle path; covered by `workers/automation/tests/test_workflow_finalize.py`. |

The durable-execution rule is simple: accepted work survives a worker restart,
cancellation reaches a terminal observable state, an unavailable Temporal path
fails clearly at start, and a lost dev-server history is reconciled rather than
left open forever.

Batch Enrich adds a cohort-level cancellation assertion: cancel a real
`JobPipelineWorkflow` after its activity starts, then prove all and only its
selected unfinished rows are `canceled`, the request identity is in the Runs
timeline, and a fresh reconciler closes persisted ownership left by a stopped
worker. The focused gate is:

```bash
uv --project workers/automation run python -m pytest -q \
  workers/automation/tests/test_workflow_job_pipeline.py::test_pipeline_enrich_cancel_terminalizes_exact_selected_cohort \
  workers/automation/tests/test_worker_reconciler.py::test_reconciler_maps_canceled_execution_to_workflow_canceled \
  workers/automation/tests/test_worker_reconciler.py::test_reconciler_cancels_persisted_enrich_ownership_after_worker_restart
```

Restart pickup is a separate regression boundary. An Enrich reset must clear
the predecessor owner and set the canonical enrichment aggregate to `pending`.
Bulk pickup must ignore stale projected descriptions, must not skip an active
Enrich owner to start Score, and must persist `firstExecutionRunId` rather than
the workflow-handle compatibility ID. The selected worker may process a queued
row only when both identifiers match; a foreign execution must leave it alone.
The focused gate is:

```bash
corepack pnpm --filter @jobctrl/api exec vitest run \
  test/server.test.ts \
  test/write-model-state.test.ts
uv --project workers/automation run --extra dev python -m pytest -q \
  workers/automation/tests/test_discover_reliability.py \
  -k 'selected_enrich_workflow_picks_up_api_prequeued_job or selected_enrich_workflow_does_not_steal_another_queued_owner'
```

Use the workflow-by-workflow matrix in the
[Regression Catalog](regression-catalog.md#temporal-fault-injection)
or the [complete checklist](complete-checklist.md#temporal-fault-injection-matrix).

### Broad-board commit/ack recovery

Broad-board discovery adds a stricter fault boundary inside the source-family
activity. The hermetic fixture commits the first JobStreaming posting and its
acceptance receipt, blocks the provider acknowledgement, kills that worker,
starts a fresh worker on the same Temporal task queue, and verifies the same
Discover execution completes from the stored checkpoint. It also covers
unacknowledged replay, durable result and filtered counts, activity-attempt
fencing, cursor reset ordering, partial board failure, incompatible cursor
schemas, and cooperative cancellation. It uses fake local adapters and performs
no external crawl:

```bash
uv --project workers/automation run pytest -q \
  workers/automation/tests/test_jobstreaming_resumable_discovery.py \
  workers/automation/tests/test_discovery_search_units.py \
  workers/automation/tests/test_jobstreaming_gateway.py
```

The provider-progress regression additionally emits a JobStreaming page
boundary carrying a private fake cursor. Verify that the worker callback,
exact-run Operations response, and expanded **Crawl sources** row expose only
the normalized provider/page counts and continuation state. The private cursor
must be absent, an event from another Temporal run must not leak into the
selected execution, and a missing provider total must not become a synthetic
percentage. With two planned families, one active family, five recent
whole-family duration samples, complete runtime inventory, and an empty task
queue, the same fixture must produce a bounded `source_rate` range. One
selected-sweep preparation workflow with several sequential stages must reserve
one slot and remain bounded when spare capacity exists; queued backlog,
unbounded retry demand, sweep demand beyond spare slots, or truncated inventory
still produces `contention_unbounded`:

```bash
corepack pnpm --filter @jobctrl/api exec vitest run \
  test/pipeline-operations.test.ts
corepack pnpm --filter @jobctrl/web exec vitest run \
  src/views/pipelines/PipelinesView.test.tsx
```

### Preparation ownership and four-process chaos

Score, Tailor, and Cover must recover from both sides of the commit boundary:
an interrupted activity before persistence leaves one retryable owned row, and
an interrupted acknowledgement after persistence reuses the committed score or
accepted artifact without another model call. Profile and browser-setting
continuations must also survive an API stop after their durable write and
before dispatch. A selected batch must honor its bounded worker count; item
failures remain attached to their own rows while the approved Tailor subset
continues to Cover. A global command that includes Tailor or Cover — including
score-led maintenance runs such as `run score tailor cover` — must freeze each
requested material stage's backlog into exact JobIds before Temporal starts,
so material stages use the same bounded per-job fan-out, ownership fence, and
worker-wave deadline instead of the legacy unscoped batch runner. Inside the
run, Score's newly scored jobs join the frozen Tailor cohort and Tailor's
approved subset joins the frozen Cover cohort. Prove each zero-row cohort is
an explicit per-stage no-op rather than an unscoped fallback — an empty Tailor
cohort must not skip a non-empty Cover backlog — that a mixed
Tailor/Cover/Apply request retains batch-Apply semantics, and that global
current-policy re-tailoring freezes the policy-aware cohort before dispatch.
An activity timeout or worker shutdown is retryable and
must not be projected as user cancellation. For an explicitly selected batch,
the replay-versioned activity deadline is 30 minutes per worker wave, capped at
6 hours; the 2-minute heartbeat still detects a dead worker promptly. Parallel
Tailor jobs generated from identical safety controls must persist distinct
job-prompt fingerprints under the same global policy revision. Changing the
complete tailoring-relevant profile projection, learned rules, model, judge,
schema, or validation mode must advance that global revision and fail stale
artifact persistence closed. A compensation-, authorization-, availability-,
EEO-, or application-preference-only profile edit must not advance the global
tailoring policy or reject an otherwise current artifact.
Cancel a real selected Tailor and Cover workflow after the first worker wave
starts. No later wave may start; in-flight jobs must receive the cooperative
cancel token; the final artifact and stage-state writes must be fenced inside
their SQLite transactions; and the exact unfinished cohort must become
`canceled` without overwriting a successor owner. A result committed before the
cancel boundary remains `succeeded`. Also pause a generation after it reads the
profile, save a new profile revision, and prove the stale generation cannot
commit. The selected artifact's prompt fingerprint must equal a digest of the
exact selected candidate message list. Exercise the production single-job
Tailor and Cover runners with their default SQLite repositories as well as the
batch workflow: cancellation during generation must leave no artifact and no
false completed/failed terminal event for the interrupted owner. Also hold a
blocking activity thread past its cancellation grace window: the abandoned
generation must be recorded and fenced, and the next activity must run on fresh
bounded executor capacity without restarting the worker.

For batch Tailor changes, exercise the actual `tailor_activity` without job IDs
as well as the selected path. Seed more eligible jobs than workers and cancel
during synthetic generation: only dispatched jobs may emit `StageStarted`, no
later item may start, and late work must preserve successor ownership and the
last accepted artifact. Verify commit-before-cancel and crash-after-commit
recovery without another generation, prerequisite blocks without attempt
spending, fifth-attempt exhaustion, tenant/limit/model policy, and approved-only
Cover scope. Use owned pre-import fixtures and the relevant Temporal workflow
matrix; the generic durable-timer demo does not prove these material invariants.

Repeated Tailor validation/model-repair failures must also keep the inner LLM
attempt count separate from the durable stage execution count. Each activity
execution advances the durable count once; the fifth durable failure retains
the non-retryable `exhausted` persistence marker, but product read models must
show a retryable failed state with reason `attempt_budget_exhausted`. A later
pickup cannot restart it without an explicit attempt reset. Verify that Retry
atomically resets the attempt count to zero. Run at least two durable failures against the same
materials generation and assert that both complete inner-attempt reports remain
in the append-only audit history.
When Tailor fails or reaches that exhausted boundary, assert that unstarted
Cover and Apply rows become non-retryable `blocked` dependencies with the exact
`UPSTREAM_TAILOR_FAILED` or `UPSTREAM_TAILOR_EXHAUSTED` code and a Tailor-owned
next action. Repeat reconciliation to prove idempotence, interleave a dependent
claim immediately before the guarded update to prove ownership preservation,
and then complete Tailor to prove only the Tailor-owned blocks reset.
For pipeline operations, seed a closed Temporal workflow whose final native
activity timed out after recording only queued/running durable events. Startup
reconciliation must append the exact terminal failure, make the stage 100%
terminal, and ensure Pipelines never renders it as active or **In progress**.
Also seed an active two-family source plan with one family running and only one
durable family row. Pipelines must report one processing and one waiting family,
with zero unknown. After terminalizing that workflow without recording the
second family lifecycle, the missing family must become unknown.
For a current score below the live materials threshold, preparation must persist
Tailor, Cover, and Apply as non-retryable `skipped` rows with `MIN_SCORE` and the
exact score/threshold pair. No row may remain `pending` after the workflow has
made that terminal policy decision. Repeating reconciliation must add no event;
a hard eligibility blocker must replace the threshold skip with `blocked`; and
lowering the threshold or using the explicit per-job low-fit override must clear
only `MIN_SCORE` rows and restore dependency-aware stage state. The rendered Job
Detail timeline must expose that reason while retaining **Tailor this job** and
must not present attempts or a retry action for the skip.
Change the enriched posting snapshot after an employer analysis exists, then
run Score and Tailor. Score must resolve the current analysis cache identity and
persist a requirement-fit report for that exact generation. A deliberately
missing or generation-mismatched report must block Tailor on Score before an LLM
candidate call, preserve the Tailor attempt count, and emit an auditable
`StageBlocked` prerequisite reason. Include a requirement-scope fixture with
one grounded technical must-have and one missing hybrid/office-attendance
must-have. The
logistics item must remain present in safe plan metadata and prompt context,
must be excluded from coverage nodes, weighted/must-have resume denominators,
and prioritized fixes, and must not consume a Tailor retry. Pair it with
negative controls such as “leading remote engineering teams” and “hybrid cloud
infrastructure” so the classifier cannot become a blunt remote/hybrid keyword
filter. With coherent inputs, sentence-level executive-profile mapping
locations must bind to the rendered summary and skill-group mappings must use
the exact rendered item sequence.
The focused deterministic gate is:

```bash
uv --project workers/automation run pytest -q \
  workers/automation/tests/test_score_activity_recovery.py \
  workers/automation/tests/test_material_activity_recovery.py \
  workers/automation/tests/test_materials_unit_of_work.py \
  workers/automation/tests/test_materials_use_cases.py \
  workers/automation/tests/test_linkedin_authenticated_enrichment_retry.py \
  workers/automation/tests/test_linkedin_apply_resolver.py \
  workers/automation/tests/test_enrichment_url_safety.py \
  workers/automation/tests/test_materials_repository.py \
  workers/automation/tests/test_v7_tailor_runtime.py \
  workers/automation/tests/test_v7_cover_runtime.py \
  workers/automation/tests/test_p1b_error_inversion.py \
  workers/automation/tests/test_temporal_worker.py \
  workers/automation/tests/test_workflow_job_preparation.py \
  workers/automation/tests/test_workflow_job_pipeline.py
corepack pnpm --filter @jobctrl/api exec vitest run \
  test/server.test.ts \
  test/json-rpc-adapter.test.ts \
  test/profile-events-v7.test.ts
```

Then run the four-process harness in both restart orders. It creates its own
temporary `JOBCTRL_DIR`, SQLite database, Temporal persistence, ports, and PID
manifest; it may kill only those captured process trees. Never point it at a
personal workspace or live application target.

```bash
JOBCTRL_RELIABILITY_RESTART_TEMPORAL=1 \
  scripts/reliability-demo.sh 1 8
JOBCTRL_RELIABILITY_RESTART_TEMPORAL=1 \
JOBCTRL_RELIABILITY_TEMPORAL_FIRST=1 \
  scripts/reliability-demo.sh 1 8
```

Both passes must retain the original Temporal run ID, complete it exactly once,
and converge in Temporal history, the SQLite read model, API health, and the
web-origin proxy. The complete R01-R25 scenario definitions and stop conditions
live in
[`plans/2026-08-04-pipeline-reliability-chaos.md`](../../plans/2026-08-04-pipeline-reliability-chaos.md).

<a id="durable-execution-recovery-demo"></a>

### Durable-Execution Recovery Demo

`scripts/reliability-demo.sh` is the scripted, re-runnable form of the
kill-worker → clean-recovery story (launch-asset 9; `docs/requirements.md`
`TR-008`). It complements the per-workflow "Kill worker mid-activity" column
above — which is unit/integration-tested — with a full-process demonstration on
a live, isolated Temporal stack. It starts an isolated dev server on a free port
and a throwaway `JOBCTRL_DIR`, then drives a burst of `DurabilityProbeWorkflow`
runs — a diagnostic workflow whose only in-flight state is a durable
`workflow.sleep` timer, so it fetches no job boards, spends no LLM tokens, and
opens no browser (the timer is what keeps a run in flight long enough to be
killed mid-flight, which a no-op that finishes in milliseconds cannot). The
script **asserts** each run is `Running`, kills the worker **by its captured PID
tree**, asserts the runs are *still* `Running` with no worker alive, starts a
fresh worker, and asserts the **same run ids** resume from Temporal history to
`Completed` exactly once — cross-checked in both Temporal and the read-model
projection. Any violation (including a run that finished before the kill, which
prints advice to raise the hold) exits non-zero.

```bash
scripts/reliability-demo.sh            # default: 3-run burst, 25s hold each
scripts/reliability-demo.sh 5          # larger burst
scripts/reliability-demo.sh 3 40       # longer hold — more margin on slow machines
```

Safety: isolated stack only (never `~/.jobctrl`, never ports 7233/8233/8766/5173),
genuinely hermetic (no crawl, no LLM spend, no browser; `LANGFUSE_DISABLE=1` stops
telemetry egress), no application submission, and it kills only the process trees
it captured. The probe workflow itself is covered by
`workers/automation/tests/test_workflow_durability_probe.py` (including same-run
resume across a worker crash on a real dev server). Requires the `temporal` CLI,
`uv`, `python3`, and `sqlite3` on `PATH`.

## High-Risk Regression Areas

| Risk | Automated coverage |
| --- | --- |
| SQLite has no backup/restore path, or the schema drifts without a `user_version` guard: unstamped databases go unnoticed, a pre-guard DB is not adopted, or a DB written by a newer build is silently downgraded by the worker or additively written by a stale TypeScript API | `workers/automation/tests/test_database_backup.py`; `apps/api/test/schema-version-guard.test.ts` |
| The daily LLM spend ceiling stops gating workflows: the budget preflight is skipped before heavy activities, an exceeded budget fails as retryable instead of a non-retryable `BudgetExceededError`, or a zero budget stops meaning unlimited | `workers/automation/tests/test_llm_spend_budget.py` |
| LLM HTTP retries stop being bounded (persistent transient failures retry forever), retry on client errors, or honor hostile `Retry-After` headers uncapped | `workers/automation/tests/test_llm_client.py` |
| First-run provider readiness drifts from the one-provider contract: Codex is marked ready from a raw key instead of persisted isolated CLI auth; Claude accepts consumer OAuth instead of one supported API/cloud route; Google Vertex treats project metadata or a missing `GOOGLE_APPLICATION_CREDENTIALS` path as credentials; one ready provider cannot service plain, structured, and employer-analysis synthesis calls; a stale optional-leg list excludes the sole ready provider; local/custom or direct OpenAI routing returns; Keychain provider replacement partially commits; or Settings cannot revoke a provider | `workers/automation/tests/test_setup_probes.py`; `workers/automation/tests/test_setup_synthesis_auth.py`; `workers/automation/tests/test_employer_analysis_leg_config.py`; `workers/automation/tests/test_llm_provider_routing.py`; `workers/automation/tests/test_llm_analysis_synthesizer.py`; `workers/automation/tests/test_bundled_runtime.py`; `workers/automation/tests/test_codex_home_isolation.py`; `apps/api/test/credentials.test.ts`; `apps/api/test/server.test.ts`; `apps/web/src/contexts/profile/components/CredentialsPanel.test.tsx`; `apps/web/e2e/tests/profile-edit.spec.ts` |
| Real-path first-run time-to-value regresses or is claimed from incomplete evidence: T0 must be captured before the first install command, TTFV-1 must prove a measured real job was absent from the all-state pre-work `/v1/jobs` baseline, has `discoveredAt >= T0`, exposes hashed real discovery-source provenance, and then is scored through both `GET /v1/jobs` and the `/jobs` fit-score badge, and TTFV-2 must prove the same measured job's real Apply Review PDF through `GET /v1/apply/review-queue`, the `/apply-review` `open final file` link, and a non-empty `/v1/artifacts/:artifactId/preview.pdf` byte stream. Synthetic data, fixtures, seeds, timing-only records, probe-only records, skipped phases, custom work commands, and CI are invalid for this gate. Owner-run cadence is pre-release only on the owner's Apple-silicon macOS reference machine: three clean runs, median TTFV-1 under 10 minutes with worst under 15 minutes, median TTFV-2 under 30 minutes with worst under 45 minutes. | `scripts/ttfv-real.mjs run` records the owner-run measurement artifact with the default discovery-inclusive command `jobctrl run discover score tailor --limit 1 --workers 1`; `scripts/ttfv-real.mjs probe` dry-validates the API/UI/PDF probes against an already-running real-output stack; `scripts/ttfv-real.mjs summarize` rejects non-gateable records and computes the median/worst aggregate; `corepack pnpm scripts:test` covers the no-spend summary gate regressions; protocol: `docs/developer/first-run-ttfv.md` |
| Dry run marks a job applied | `workers/automation/tests/test_apply_regressions.py` |
| Apply process hangs while stdout stays open | `workers/automation/tests/test_apply_regressions.py` |
| Targeted apply skips fresh jobs | `workers/automation/tests/test_apply_regressions.py` |
| Live apply claims bypass the default approval gate, ignore the latest Apply Review decision, fail to leave the job pending with an awaiting-approval event, give a model-driven browser final-submit authority, let a direct use-case/saga/adapter call recover that authority, send an email outside the exact approved recipient/attachment binding, place profile/job-description/resume/cover-letter/generated prose or local artifact paths in the Apply prompt, stage reviewed materials in the agent worker, expose artifact-upload authority that a hostile same-origin page can reflect into model-visible DOM, expose generic text/form/key/select/drag/dialog writes, saved-credential typing, or Gmail verification values to the page-reading model, leak profile passwords or CAPTCHA-provider keys into the prompt, allow more than one outbound CAPTCHA-provider attempt per apply run, derive saved-password authority from an untrusted application URL, or allow direct API/RPC dispatch to bypass an enabled `approve_submit` gate | `workers/automation/tests/test_apply_use_cases.py`; `workers/automation/tests/test_apply_saga.py`; `workers/automation/tests/test_apply_regressions.py`; `workers/automation/tests/test_apply_prompt_builder.py`; `workers/automation/tests/test_apply_tools_mcp_server.py`; `workers/automation/tests/test_claude_code_cli_adapter.py`; `apps/api/test/application-feedback.test.ts`; `apps/api/test/server.test.ts`; `apps/web/src/contexts/profile/forms/settings-form.test.tsx`; `apps/web/src/views/apply-review/ApplyReviewView.test.tsx` |
| A confirmed application to the same canonical job or accepted duplicate identity can submit again by default; an equivalent role at the same employer bypasses deliberate confirmation; a distinct role or similar-employer false positive is blocked; pending suggestions, notes, dry runs, failed pre-submit attempts, or intent alone establish history; a direct dispatch, standing loop, concurrent claim, or stale approval bypasses or consumes the guard incorrectly; or the prior evidence, reasoned override, timestamp, fingerprint, and one-attempt consumption are not inspectable | `workers/automation/tests/test_repeat_application_prevention.py`; `apps/api/test/repeat-application.test.ts`; `apps/api/test/application-feedback.test.ts`; `apps/web/src/views/apply-review/ApplyReviewView.test.tsx`; `apps/web/e2e/tests/repeat-application.spec.ts` |
| An owned email send records intent anywhere except immediately before the sender, a crash or provider exception after submit intent blindly retries or auto-requeues instead of parking `needs_verification`, or a crash before intent fails to rewind safely to `pending` | `workers/automation/tests/test_apply_regressions.py`; `workers/automation/tests/test_apply_saga.py`; `workers/automation/tests/test_workflow_apply.py`; `apps/api/test/application-feedback.test.ts`; `packages/domain-types/test/pipeline.test.ts` |
| Apply browser enforcement accepts a public page-target request outside the reviewed canonical application origin; allows a dedicated/shared/service worker to execute outside that interception boundary; browser-layer dry-run enforcement allows anything except one exact run-bound initial `GET`, permits its replay or a path/query/redirect change, omits the sanitized allowed-navigation decision from durable evidence, claims full coverage without that decision, fails to block hostile POST/PUT/PATCH/DELETE, form submission, WebSocket/beacon channels, script-initiated document navigation, or subresource GET/HEAD exfiltration; or a transport-locked rehearsal stops reaching the approved local fixture server | `workers/automation/tests/test_apply_origin_policy.py`; `workers/automation/tests/test_apply_chrome_dry_run_guard.py`; `workers/automation/tests/test_apply_saga.py`; `workers/automation/tests/test_apply_regressions.py`; `apps/api/test/application-feedback.test.ts` |
| Apply result evidence disappears; raw agent output is not persisted; an error result envelope, assistant narration, page-influenced prose, a missing or multiple terminal record, extra text, or conflicting tokens select a success state; a model-only dry-run claim becomes full approval evidence; or a model-reported applied token becomes an authoritative submission receipt | `workers/automation/tests/test_claude_code_cli_adapter.py`; `workers/automation/tests/test_apply_saga.py`; `workers/automation/tests/test_apply_regressions.py` |
| Auto-apply kills the launcher on agent timeout, uploads files outside the worker sandbox, exposes arbitrary file upload paths, loops on browser Gmail, returns raw inbox content to the model, exposes mailbox send tools to the agent, sends email applications without a recorded candidate plus matching Apply Review binding, or cannot report Gmail connector auth readiness | `workers/automation/tests/test_claude_code_cli_adapter.py`; `workers/automation/tests/test_apply_prompt_builder.py`; `workers/automation/tests/test_apply_use_cases.py`; `workers/automation/tests/test_apply_saga.py`; `workers/automation/tests/test_apply_tools_mcp_server.py`; `workers/automation/tests/test_gmail_connector.py`; `workers/automation/tests/test_gmail_mcp_config.py`; `workers/automation/tests/test_doctor_gmail_mcp.py` |
| Stages cannot be retried individually | `workers/automation/tests/test_state_dashboard.py` |
| Explicit stage state loses to compatibility columns | `workers/automation/tests/test_state_dashboard.py` |
| A retry with `runAfter: true` resets a failed stage before worker readiness succeeds, so a 503 erases attempt/error/retryability evidence without dispatching replacement work | `apps/api/test/server.test.ts` (`does not reset a retry stage when run-after requires an unavailable worker`) |
| Passive browser detection launches, adopts, or persists a browser; returns a local executable path instead of an opaque kind and label; accepts a stale detected ID; hides the advanced manual fallback; or implies browser-profile copy consent | `workers/automation/tests/test_browser_capabilities.py`; `workers/automation/tests/test_browser_capabilities_rpc.py`; `apps/api/test/server.test.ts`; `apps/web/src/contexts/operations/components/BrowserCapabilitiesPanel.test.tsx`; `apps/web/src/contexts/operations/components/BrowserCapabilitiesPanel.a11y.test.tsx` |
| An environment-owned active provider route becomes editable/removable, or locking it also prevents an alternative supported auth route from being edited; saving the alternative falsely claims it displaced the environment before removal and restart | `apps/web/src/contexts/profile/components/CredentialsPanel.test.tsx`; `apps/web/src/contexts/profile/forms/provider-setup-forms.test.tsx`; `apps/api/test/credentials.test.ts`; `apps/api/test/server.test.ts` |
| The Rhea/Base UI boundary regresses: token contrast fails, direct Radix imports or raw native selects return, primitive behavior breaks, or the rendered light/dark/density/focus foundation drifts | `apps/web/src/styles/token-contrast.test.ts`; `apps/web/src/shared/ui/base-ui-migration-boundary.test.ts`; focused shared primitive tests; `apps/web/e2e/tests/token-foundation.spec.ts`; `apps/web/e2e/tests/route-visual-qa.spec.ts` |
| Pipeline operations blends source families with reconciliation, loses execution/sweep/global-backlog scope, leaks private identifiers, misses event invalidation or bounded polling, or invents ETA/freshness/capacity/queue/inventory certainty | `apps/api/test/pipeline-operations.test.ts`; `apps/api/test/pipeline-eta.test.ts`; `apps/api/test/worker-runtime-telemetry.test.ts`; `apps/web/src/views/pipelines/PipelinesView.test.tsx`; `apps/web/src/contexts/operations/hooks/usePipelineOperationsQuery.test.ts`; `apps/web/src/contexts/operations/invalidation-router.test.ts`; `apps/web/e2e/tests/docs-screenshots.spec.ts` |
| Pipeline actions write events to a different DB, hide running stages, miss in-flight workflow stop controls, ignore bounded stage limits, selected job URL sets, or selected Discover source IDs, leave bulk-retried failed jobs or pending preparation backlogs dependent on page-local pickup, show opaque Discover `0/N` progress while a source is mid-crawl, duplicate a long-running Discover source-family activity after timeout, or leave stopped source runs marked active | `apps/api/test/server.test.ts`; `apps/api/test/json-rpc-adapter.test.ts`; `workers/automation/tests/test_runtime_identity.py`; `workers/automation/tests/test_jsonrpc_handlers.py`; `workers/automation/tests/test_rpc_handlers_apply_workflow.py`; `workers/automation/tests/test_pipeline_observability.py`; `workers/automation/tests/test_discovery_limits.py`; `workers/automation/tests/test_workflow_job_pipeline.py`; `workers/automation/tests/test_workflow_discovery.py`; `apps/web/src/contexts/pipeline/components/StageTriggerPanel.test.tsx`; `apps/web/src/contexts/pipeline/components/CancelWorkflowRunButton.test.tsx`; `apps/web/src/contexts/pipeline/hooks/useCancelWorkflowRunMutation.test.ts`; `apps/web/src/contexts/pipeline/hooks/useRunPendingPreparationMutation.test.ts`; `apps/web/src/views/jobs/JobsView.test.tsx`; `apps/web/src/views/runs/RunsTable.test.tsx`; `apps/web/src/contexts/operations/invalidation-router.test.ts` |
| Transient worker-stage failures are swallowed as normal `"error: ..."` results instead of retrying under Temporal, or non-retryable configuration/auth/input failures waste retry attempts instead of failing fast with a durable `error_code` | `workers/automation/tests/test_p1b_error_inversion.py`; `workers/automation/tests/test_workflow_finalize.py`; `workers/automation/tests/test_workflow_job_pipeline.py` |
| Workflow cancellation leaves a zombie activity thread, fails to set the cooperative source cancel event, drops the cancellation projection, or hides a thread that ignored cancellation instead of emitting `abandoned_thread` operational evidence | `workers/automation/tests/test_p1b_error_inversion.py`; `workers/automation/tests/test_workflow_finalize.py` |
| Worker lifecycle regresses: the reconciler stops terminalizing lost open workflow rows, the worker heartbeat loop stops writing `worker_runtime_heartbeats`, duplicate workflow starts overlap instead of reusing the open run, or the workflow starter drops its dispatch-time open row | `workers/automation/tests/test_worker_reconciler.py`; `workers/automation/tests/test_worker_heartbeat_loop.py`; `workers/automation/tests/test_workflow_id_overlap.py`; `workers/automation/tests/test_workflow_starter_cache.py` |
| Discovery source cancellation reaches only broad boards, leaving ATS, Workday, or Smart Extract in-flight after a workflow cancel | `workers/automation/tests/test_p1b_error_inversion.py` |
| The TypeScript API drops its loopback `Host`-header allowlist (DNS-rebinding defense), lets browser-extension CORS/token trust escape `/v1/extension/*`, lets a valid extension token bypass the loopback Host gate, fails to seed extension captures through `manual_capture_queue`, or serves/opens an artifact whose resolved path escapes the JobCtrl app directory | `apps/api/test/server.test.ts` (`rejects requests whose Host header is not a loopback host`; `blocks foreign-Host mutations before the handler runs`; `keeps the Host gate mandatory for valid extension bearer tokens`; `allows CORS preflight only for authenticated extension API routes`; `trusts valid extension bearer tokens only on extension API routes without weakening CSRF`; `refuses to open an artifact whose path resolves outside the app directory`; `refuses to preview a PDF artifact whose path resolves outside the app directory`); `apps/api/test/discovery-controls.test.ts` (`seeds extension captures into the manual capture queue before worker import`) |
| The browser extension loses exact HTTP(S)-wildcard page reach, gains access to non-web schemes, broadens outbound network permissions beyond loopback, ships a non-loopback network literal, runs form inspection without an explicit review request, loses the stack-down local queue bound, stops sending captures/profile reads with a local bearer token, fabricates missing autofill values, or gains a submit path | `apps/extension/src/privacy.test.ts`; `apps/extension/src/privacy.e2e.test.ts`; `apps/extension/src/chromium-extension.e2e.test.ts`; `apps/extension/src/local-api.test.ts`; `apps/extension/src/queue.test.ts`; `apps/extension/src/content-script.test.ts` |
| A saved pairing token is presented as live Discovery readiness; Discover dispatches while the extension heartbeat is offline; a broker task loses exact workflow/run identity, bounded lease/result/cancellation, public URL validation, or memory-only retention; worker-supplied Cookie/User-Agent headers cross into Chrome; the extension uses a copied/new profile; or any JobStreaming, ATS, Workday, Smart Extract, robots, or integrated detail-enrichment acquisition bypasses the live-profile extension transport | `apps/api/test/discovery-browser-broker.test.ts`; `apps/api/test/discovery-browser-routes.test.ts`; `apps/extension/src/discovery-executor.test.ts`; `apps/extension/src/chromium-extension.e2e.test.ts`; `workers/automation/tests/test_live_browser_discovery.py`; `workers/automation/tests/test_discovery_production_wiring.py`; `workers/automation/tests/test_workday_discovery.py`; `workers/automation/tests/test_smartextract_discovery.py`; `workers/automation/tests/test_discover_reliability.py`; `apps/web/src/contexts/profile/components/SettingsPanel.test.tsx`; `apps/web/src/contexts/pipeline/components/StageTriggerPanel.test.tsx`; live product-path QA from `docs/local-reliability-qa.md` |
| The release privacy gate regresses: `scripts/release_check.py` stops catching a seeded violation class (owner-derived needles, secrets, prompt tripwires, blocked file types, or mismatched release metadata) or its CLI exit code stops failing CI | `workers/automation/tests/test_release_check.py` |
| Operational metrics collapse scraper, manual abort, reload, harness, and unknown failures into one failed status | `workers/automation/tests/test_operational_metrics.py`; `apps/api/test/projections.test.ts` |
| Discovery cancel-all-sources regresses, so stopping `DiscoverWorkflow` reaches broad boards but leaves ATS, Workday, Smart Extract, or enrichment running without observing the cooperative cancel event | `workers/automation/tests/test_p1b_error_inversion.py`; `workers/automation/tests/test_workflow_discovery.py::test_discover_workflow_detects_activity_cancellation_cause`; `workers/automation/tests/test_workflow_discovery.py::test_discover_workflow_records_canceled_outcome`; manual QA: start Discover against all source families in a disposable workspace, cancel from Runs, and confirm no source-family activity continues writing progress after cancellation |
| Discovery quarantine-on-repeated-failure regresses, so three concrete Workday/source-family failures do not quarantine only the failed source id | `workers/automation/tests/test_source_quality_projection_pr4.py::test_source_quality_quarantines_only_failed_workday_source`; manual QA: inject repeated failures for one configured Workday source and confirm only that source enters quarantined state |
| Discovery schedule toggle stops honoring disabled-by-default or Temporal `SKIP` overlap semantics | `workers/automation/tests/test_workflow_discovery.py::test_discovery_schedule_defaults_disabled`; `workers/automation/tests/test_workflow_discovery.py::test_discovery_schedule_reconcile_creates_skip_overlap_schedule`; manual QA: enable scheduling, restart the worker, confirm one `jobctrl-discovery-local` schedule with overlap `SKIP`, then disable and confirm it is deleted |
| Score-as-you-discover streaming regresses: enrichment/preparation fan-out reverts to running once at end-of-run (a job discovered early stays unscored until the run finishes); a repeated per-family fan-out starts duplicate `JobPreparationWorkflow` executions instead of reusing the deterministic `prep-{idempotency_key}` id via `USE_EXISTING`; a fresh job crossing `pending_score` → `pending_tailor` mid-tailor is double-fanned as a second TAILOR_RESUME workflow; a later family's failure undoes earlier fan-outs or breaks the tolerated-partial-failure folding; a job fanned out mid-run bypasses the per-job spend preflight or the `min_score` gate; or the Runs progress bar regresses / misreports per-family progress | `workers/automation/tests/test_workflow_discovery.py::test_discover_workflow_runs_sources_then_enrichment_and_fanout` (interleaved order); `::test_discover_workflow_tolerates_partial_source_failure` and `::test_discover_workflow_fails_only_when_every_source_fails` (I2 folding under streaming); `workers/automation/tests/test_discovery_preparation_orchestration.py::test_streaming_fanout_dedups_repeated_passes_via_deterministic_ids` and `::test_derive_targets_score_only_skips_pending_tailor` (I1 dedup + no double-tailor); `workers/automation/tests/test_workflow_job_preparation.py::test_preparation_workflow_fails_fast_when_budget_exceeded_and_spends_nothing` (I4); `workers/automation/tests/test_workflow_discovery.py::test_discover_workflow_kill_worker_resumption` (I3/I6 under the new order); per-job handoff (R9 Phase 2): `workers/automation/tests/test_discover_reliability.py::test_scrape_site_batch_hands_off_each_job_as_it_is_enriched` (promptness — a job is handed off before its siblings are scraped) and `::test_scrape_site_batch_handoff_error_does_not_break_enrichment`, `workers/automation/tests/test_discovery_preparation_orchestration.py::test_per_job_handoff_id_converges_with_fanout_and_forks_on_reenrichment` (I1 at per-job granularity + material-change fork), `workers/automation/tests/test_workflow_discovery.py::test_build_per_job_handoff_starts_scored_prep_with_params`; parallel families (R9 Phase 3, gated by Discovery Runtime's SQLite-backed `max_parallel_families` setting, default 1): `workers/automation/tests/test_workflow_discovery.py::test_parallel_families_respect_the_cap`, `::test_sequential_default_runs_one_family_at_a_time`, `::test_parallel_family_results_fold_in_submission_order` (determinism), `::test_parallel_partial_failure_preserves_folding` (I2), `::test_parallel_family_cancellation_cancels_the_run` (cancel-all), `workers/automation/tests/test_temporal_concurrency.py::test_max_parallel_discovery_families_defaults_to_sequential`; manual QA: run Discover over ≥2 families in a disposable workspace and confirm the first family's jobs show scores while a later family is still crawling, and that progress advances monotonically to a truthful terminal state (TTFS protocol); with the cap raised, confirm concurrent browser count stays within the documented bound |
| JobStreaming discovery loses or double-counts a posting when the worker dies after the JobCtrl commit but before provider acknowledgement; a stale attempt can still write after reclaim; a cursor reset runs before its error acknowledgement; the durable limit restarts; checkpoint incompatibility silently resets; explicit cancellation resumes as stale work; or recovered work is invisible | `workers/automation/tests/test_jobstreaming_resumable_discovery.py`; `workers/automation/tests/test_discovery_search_units.py`; `workers/automation/tests/test_jobstreaming_gateway.py`; `workers/automation/tests/test_pipeline_observability.py`; `apps/api/test/server.test.ts`; `apps/web/src/contexts/pipeline/components/StageTriggerPanel.test.tsx` |
| Kill-worker discovery resumption regresses, requiring a reaper or manual action instead of Temporal retrying incomplete source-family activities and completing discovery | `workers/automation/tests/test_workflow_discovery.py::test_discover_workflow_kill_worker_resumption`; `workers/automation/tests/test_jobstreaming_resumable_discovery.py::test_temporal_worker_loss_after_store_before_ack_reclaims_and_completes`; manual QA: run Discover in a disposable workspace, kill the worker mid-source activity, restart the worker, and confirm the workflow completes with no orphan reaper |
| Cover letters use the wrong resume | `workers/automation/tests/test_cover_requirements.py` |
| Resume tailoring accepts a merely validation-passing resume, ignores generator/judge routing, hides judge rejection or high-fit adversarial blockers as success, fails to retry non-blocking review warnings while budget remains, omits auditable source-vs-tailored change annotations, requirement-led coverage graph metadata, generated-claim mappings, review-blocking adjacent/draft labels, hard per-role bullet ceilings, actionable keyword coverage counts, persona prompt/response/score audit, or expandable LLM request/response trails for persona warnings, lets low-signal marketing tokens pollute tailoring keywords, persists unsafe provider config, accepts unsupported metrics or keyword stuffing, drops profile evidence controls, or lets CLI/RPC/Temporal/API contracts drop tailoring model controls | `workers/automation/tests/test_requirement_led_tailoring.py`; `workers/automation/tests/test_materials_quality_eval.py`; `workers/automation/tests/test_materials_quality.py`; `workers/automation/tests/test_materials_adversarial.py`; `workers/automation/tests/test_materials_use_cases.py`; `workers/automation/tests/test_content_validator.py`; `workers/automation/tests/test_tailor_retailor.py`; `workers/automation/tests/test_activity_tailor.py`; `workers/automation/tests/test_actions.py`; `workers/automation/tests/test_jsonrpc_handlers.py`; `workers/automation/tests/test_llm_port.py`; `apps/api/test/application-feedback.test.ts`; `apps/api/test/json-rpc-adapter.test.ts`; `apps/web/src/contexts/profile/components/StructuredProfileEditor.test.tsx` |
| A resume or cover-letter retry promotes free-form validator, judge, adversarial-review, or prior-model text into a later generator system/user message instead of retaining it as audit-only data and using bounded code-owned reason guidance | `workers/automation/tests/test_materials_use_cases.py` |
| Stored interview prep bypasses the existing fabrication, claim-grounding, or adversarial judge gates; accepts a fabricated metric/tool or dishonest gap drill; supersedes the last accepted prep after a failed refresh; omits the projected `JobDetail.interviewPrep` provenance read model; or exposes a live/in-session/transcript/microphone/streaming/real-time assistance contract instead of a stored prep generation | `workers/automation/tests/test_interview_prep_generation.py`; `workers/automation/tests/test_jsonrpc_handlers.py` (`test_interview_prep_has_no_live_assistance_surface`); `workers/automation/tests/test_audit_projection_parity.py`; `apps/api/test/audit-projection-parity.test.ts`; `apps/api/test/json-rpc-adapter.test.ts`; `apps/api/test/rpc-contracts.test.ts`; `apps/web/src/contexts/materials/components/InterviewPrepPanel.test.tsx`; `apps/web/e2e/tests/interview-prep.spec.ts` |
| The post-generation revision gate trusts the model's self-declared claim mappings instead of grounding them in the shipped rendered text, so the persisted "Must-have coverage 100% · passed" record can contradict the provenance-backed requirement audit on the Apply Review surface ("4/9 requirements covered" with must-haves marked missing from the tailored resume). Coverage-bearing claims must count only when bound to a shipped line (location + text binding, with the same bullet's pre-voice text honored for voice-reworded lines and the assembler's policy-gated summary swap treated as unshipped), claimed-only requirements must fail the gate with explicit shipped-resume fixes feeding the revision loop, provenance rows must carry the grounded claim requirement links so chips/badge/gate derive from one criterion, the shipped artifact must persist a lifecycle-labeled post-voice grounded fit record (`post_generation_fit_final`), and the Apply Review read model must label the gate's coverage basis (grounded vs judge-claimed legacy) rather than hiding it, surface the shipped grounded fit with its post-acceptance warnings, and report revisions used (`attempt - 1`) instead of a raw attempt ordinal so the badge, chips, and gate never contradict each other | `workers/automation/tests/test_claim_grounding.py`; `workers/automation/tests/test_requirement_led_tailoring.py` (`test_grounded_gate_reproduces_apply_review_contradiction_shape`, `test_post_generation_fit_score_rejects_claims_absent_from_shipped_text`); `workers/automation/tests/test_tailor_voice_audit_integration.py`; `apps/api/test/application-feedback.test.ts`; `apps/web/src/views/apply-review/ApplyReviewView.test.tsx` |
| Voice pass runs after (not before) the final audit, audits/coverage diverge from the rendered/PDF text, a voiced bullet is not recorded as the `voice` transform, the never-fabricate detector/provenance are not re-run after voice (a voice-introduced unsourced metric ships), keyword coverage is inferred from the job description or counts an ungrounded keyword-stuffed line as covered, a skill the user declares in `skill_categories` and ships in the resume's skills line is falsely reported `missing` instead of the honest `declared` bucket (or is silently credited as `covered` without evidence), or a voice error/regression sinks the otherwise-approved resume instead of falling back to the clean pre-voice candidate | `workers/automation/tests/test_voice_metrics.py`; `workers/automation/tests/test_voice_payload.py`; `workers/automation/tests/test_voice_adapter.py`; `workers/automation/tests/test_coverage_audit.py`; `workers/automation/tests/test_bullet_provenance.py`; `workers/automation/tests/test_tailor_voice_audit_integration.py`; `apps/api/test/projections.test.ts`; `apps/api/test/audit-projection-parity.test.ts`; `apps/web/src/contexts/materials/components/TailoringExplanationSection.test.tsx` |
| A re-tailor supersedes the prior approved generation before the replacement resume PDF is durable, so a transient PDF render failure strips the job of its last accepted resume (`load_current_approved` returns nothing), publishes a dangling `ResumeApproved` with no artifact, or orphans provenance against the now-rejected generation | `workers/automation/tests/test_tailor_provenance_integration.py`; `workers/automation/tests/test_materials_use_cases.py`; `workers/automation/tests/test_tailor_retailor.py` |
| The tailor generation flip (supersede prior + save new generation + record provenance/coverage) commits per repository instead of atomically, so a crash between the supersede and the new-generation save leaves `load_current_approved` transiently empty, or a provenance write failure after the artifact commits leaves an approved generation with no provenance | `workers/automation/tests/test_materials_unit_of_work.py`; `workers/automation/tests/test_tailor_provenance_integration.py` |
| A fabricated in-demand skill/tool (Kubernetes, Terraform, Kafka, …) is woven into an experience bullet or the executive summary and ships because the deterministic detector only checks numeric/date/title/employer tokens and the prose skill check is a short denylist. The prose skill/tool gate must hard-reject (resume NOT approved, prior accepted generation preserved) any job-target skill/tool keyword present in the shipped prose that grounds in neither the profile skill vocabulary nor the evidence corpus, while never false-firing on profile-backed tools, corpus-grounded concept terms (`latency`), or ordinary English words | `workers/automation/tests/test_bullet_provenance.py`; `workers/automation/tests/test_materials_use_cases.py` |
| The never-fabricate scan runs the numeric/date/title/employer arms over the SKILLS section rows against the whole-resume corpus (which excludes skill categories), so a DECLARED versioned skill (`Java 17`, `OAuth 2.0`) is flagged as a fabricated number and hard-rejects the whole resume; skills rows must instead ground against the declared skill items themselves, while a skills numeric absent from every declared item (a renderer bug / injected item) is still caught | `workers/automation/tests/test_bullet_provenance.py`; `workers/automation/tests/test_materials_use_cases.py` |
| A deterministic gate finding (prose skill fabrication, never-fabricate numeric/title, or provenance FK binding) on the selected candidate fails the whole tailor run without feeding the finding back into the attempt loop, so a resume fixable on retry is rejected outright; a hard finding with retry budget remaining must re-enter the loop with the finding rendered as an `avoid_note` (recorded as per-candidate `failed_fabrication_gate` repair-loop history) and still fail-closed — resume NOT approved, prior accepted generation preserved — when every candidate trips the gate | `workers/automation/tests/test_materials_use_cases.py` |
| A cover letter ships to the employer with a fabricated metric/date/title/employer or a job-target skill/tool the profile cannot back, because its only gate is structural (banned words, dashes, word count, salutation/closing). The cover-letter body must run the same deterministic grounding gates the resume uses (never-fabricate detector + prose skill/tool gate) before acceptance, hard-reject a fabrication (letter REJECTED, aggregate stays `resume_approved`, failure kept as `fabrication_audit` history), and never false-reject legitimate content (the `Dear` salutation, the target company/role, declared skills, evidence tools, real profile numbers, or JD concept keywords in varied word forms such as scalability/reliability/observability — the skill gate is scoped to named technologies with word-form-tolerant grounding) | `workers/automation/tests/test_materials_use_cases.py` |
| A failed cover-letter refresh overwrites the approved text file or replaces the canonical approved artifact with the rejected candidate; a validation-passing refresh mutates approved bytes before the replacement pointer is durably saved; or replacement text remains paired with the prior approved PDF after rendering fails. Every refresh must use a new immutable path; rejected bytes and validation remain inspectable in `cover_letter_attempts`; validation or persistence failure must leave the prior approved path, bytes, lifecycle state, SQLite round-trip, and projected path unchanged; and successful text replacement must persist the old PDF as superseded and project the job as pending PDF until the new render succeeds | `workers/automation/tests/test_materials_aggregate.py` (`test_with_cover_letter_replacement_clears_stale_pdf`); `workers/automation/tests/test_materials_use_cases.py` (`test_cover_letter_failed_refresh_preserves_last_approved_artifact`, `test_cover_letter_refresh_persistence_failure_preserves_approved_bytes`, `test_cover_letter_refresh_drops_stale_pdf_before_renderer_failure`); `workers/automation/tests/test_materials_repository.py` (`test_rejected_cover_refresh_round_trips_without_changing_projected_path`, `test_approved_cover_refresh_supersedes_stale_pdf_and_projects_pending_pdf`) |
| Profile PDF import corrupts defaults or drops tailoring claim/evidence controls | `workers/automation/tests/test_profile_import.py`; `workers/automation/tests/test_profile_aggregate.py`; `workers/automation/tests/test_sqlite_profile_repository.py`; `apps/web/src/contexts/profile/components/StructuredProfileEditor.test.tsx` |
| API list filtering/sorting/pagination or shared data-grid filtering/sorting/pagination/column resizing regresses | `apps/api/test/server.test.ts`; `apps/web/src/shared/ui/filterable-data-grid.test.tsx`; `apps/web/src/views/debug/DebugActivityTable.test.tsx` |
| Saved Jobs table views stop treating URL filters/sort as the active source of truth, lose migration safety for renamed/removed columns, or fail to restore column visibility/order/widths and table density after a reload | `apps/web/src/shared/stores/saved-table-views.test.ts`; `apps/web/src/shared/ui/filterable-data-grid.test.tsx`; `apps/web/src/views/jobs/JobsView.test.tsx`; browser smoke on `/jobs` |
| Dashboard KPI drilldowns stop matching their Jobs list filters | `apps/api/test/server.test.ts`; `apps/web/src/views/dashboard/KpiGrid.test.tsx`; `apps/web/src/views/jobs/JobsView.test.tsx` |
| Apply-run drawers show roadmap placeholder copy instead of persisted timeline events | `apps/api/test/server.test.ts`; `apps/web/src/contexts/apply/components/ApplyRunTimeline.test.tsx` |
| Dashboard stops classifying canonical running-stage timestamps into active versus stuck work, hides stuck items or the liveness threshold, drops starting/in-progress workflow runs, loses recent activity, lets activity events overload the view, or makes events uninspectable from Debug | `apps/api/test/server.test.ts`; `apps/web/src/contexts/operations/hooks/useDashboardSummaryQuery.test.ts`; `apps/web/src/views/dashboard/active-runs.test.ts`; `apps/web/src/views/dashboard/DashboardView.test.tsx`; `apps/web/src/views/dashboard/DashboardOperations.a11y.test.tsx`; `apps/web/src/views/debug/DebugActivityTable.test.tsx`; `apps/web/src/views/debug/DebugView.test.tsx`; `apps/web/e2e/tests/dashboard.spec.ts` |
| Outcome-conversion and outcome-analytics read models or views miscount applied/reply/interview/offer/rejection per source, score band, fit band, apply mode, accepted resume template, or tailoring policy; conflate score-band and fit-band vocabularies; include dry-runs in the applied denominator; divide by zero on zero-applied instead of null rates; report a statistically meaningless rate or median for a bucket below the minimum sample size (`MIN_CONVERSION_SAMPLE` in `apps/api/src/read-model.ts`, default 5 — e.g. a single applied job rendering a 100% response rate) instead of suppressing the rate while keeping the raw counts and `n`; miscount response-time samples or suggestion decisions; sort by rate by default instead of applied count; show suppressed rate rows ahead of rated rows during rate sorting; leak notes/body text through analytics; drift between the Python and TypeScript projection builders; or stop being read-only (feeds scoring/ranking/thresholds or apply eligibility) | `workers/automation/tests/test_dashboard_projection.py`; `apps/api/test/projections.test.ts`; `workers/automation/tests/test_audit_projection_parity.py`; `apps/api/test/audit-projection-parity.test.ts`; `apps/web/src/contexts/operations/hooks/useOutcomeAnalyticsQuery.test.ts`; `apps/web/src/contexts/operations/invalidation-router.test.ts`; `apps/web/src/views/analytics/AnalyticsView.test.tsx`; `apps/web/src/views/analytics/AnalyticsView.a11y.test.tsx`; `apps/web/src/views/analytics/OutcomeRateTable.test.tsx`; `apps/web/src/views/analytics/AnalyticsView.stories.tsx`; `apps/web/e2e/tests/analytics.spec.ts` |
| Dashboard conversion panel stops rendering the applied→reply→interview→offer funnel with rates relative to applied, drops the per-source or per-score-band interview breakdown, fabricates a cost per interview instead of showing "not available" when null, fabricates a percentage for a below-minimum-sample bucket instead of showing the raw counts with "n/a" plus an insufficient-data note, or renders a broken chart instead of an empty state when no applications exist | `apps/web/src/views/dashboard/ConversionPanel.test.tsx`; `apps/web/src/views/dashboard/ConversionPanel.a11y.test.tsx`; `apps/web/src/views/dashboard/DashboardView.test.tsx` |
| Job detail audit history misses user-relevant lifecycle entries, duplicates raw event payloads, or exposes debug messages, raw notes, email bodies, or local paths | `apps/api/test/server.test.ts`; `apps/web/src/views/jobs/JobDetailDrawer.test.tsx` |
| Job Detail stops opening as a full route audit workspace, or stops showing top-level ranking rationale, apply readiness, blockers, eligibility concerns, or Apply Review handoff from the shared audit contract | `apps/web/src/views/jobs/JobDetailDrawer.test.tsx`; browser smoke on `/jobs/$jobId` |
| Requirement-fit explanation regresses by deriving requirement matches from broad score-signal text, hiding the `not_assessed` state for scores without requirement-level evidence, omitting the current-policy re-score path, or letting Apply Review requirement coverage disagree with the projected requirement-fit report | `apps/web/src/contexts/materials/components/EmployerAnalysisPanel.test.tsx`; `apps/web/src/views/jobs/JobDetailDrawer.test.tsx`; `apps/web/src/views/apply-review/ApplyReviewView.test.tsx`; browser smoke on a `/jobs/$jobId` route workspace and `/apply-review` |
| Jobs delete/hide lifecycle regresses, causing temporary deletes not to resurface, hidden jobs to leak into active/deleted views, permanent deletes to leave suppressing tombstones behind, or a rejected cross-source content-matched duplicate (distinct URL/source/location) to soft-delete the accepted owner it matched instead of dropping only the incoming duplicate | `apps/api/test/server.test.ts`; `workers/automation/tests/test_discovery_identity.py`; `apps/web/src/views/jobs/JobBulkActions.test.tsx`; `apps/web/src/views/jobs/JobsView.test.tsx` |
| Cross-source content dedup regresses, letting the same posting create a second Job aggregate — via Smart Extract's direct-SQL insert bypassing the content-owner lookup, JobSpy rediscovery of an ATS-first owner whose `jobs.company` is NULL (employer only in `jobs.site`), or a fresh listing arriving after the owner is enriched (listing-vs-enriched similarity drops below threshold) — or the rejected-duplicate audit stops attributing to the surviving owner or appends a fresh event row on every re-observation of an already-rejected duplicate, or the accepted-merge `DuplicateJobLinked` event fails to attribute to the surviving owner (persisted with a NULL `job_url` and absent from the owner's audit history) | `workers/automation/tests/test_discovery_identity.py`; `workers/automation/tests/test_discovery_limits.py`; `workers/automation/tests/test_smartextract_discovery.py`; `apps/api/test/server.test.ts` |
| Destructive UI workflows touch real user data | `apps/api/test/qa-workflow.test.ts` with `corepack pnpm qa:seed` |
| Source registry compatibility drops discovery config aliases | `workers/automation/tests/test_source_registry.py` covers packaged `sites.yaml` and `employers.yaml` imports, broad-board `boards` selection through the internal `jobspy` compatibility key, and the `sites` alias warning |
| Posted compensation parsing loses explicit states, over-captures source text, annualizes without assumptions, mutates `jobs.salary`, writes facts from API GET reads, leaks private data, or changes fit score, sorting, filtering, apply readiness, or apply dispatch behavior | `workers/automation/tests/test_posted_compensation_parser.py`; `workers/automation/tests/test_posted_compensation_repository.py`; `workers/automation/tests/test_discovery_identity.py`; `workers/automation/tests/test_discovery_limits.py`; `apps/api/test/posted-compensation-facts.test.ts`; `apps/api/test/server.test.ts` (`compensation boundary`) |
| Score eligibility fabricates a hard blocker from a preference — accepting model-supplied compensation blockers, treating any posted compensation below the profile range or a remote-vs-onsite work-model mismatch as a blocker, mis-annualizing hourly/daily/weekly/monthly pay, or dropping the warning source and parsed figure from the audit trail — instead of keeping those mismatches auditable and allowing materials to continue | `workers/automation/tests/test_score_use_cases.py` (`test_score_job_demotes_model_compensation_blocker_to_warning`, `test_constraint_checker_hourly_pay_annualizes_and_does_not_false_block`, `test_constraint_checker_hourly_below_minimum_is_warning_with_annualization_audit`, `test_constraint_checker_confident_annual_below_minimum_is_warning_with_source`, `test_constraint_checker_monthly_pay_below_minimum_is_warning_not_hard_blocker`, `test_constraint_checker_weekly_pay_annualizes_and_does_not_false_block`, `test_constraint_checker_daily_rate_below_minimum_is_warning_not_hard_blocker`, `test_constraint_checker_bare_amount_without_period_is_still_read_as_annual`, `test_constraint_checker_remote_work_model_mismatch_is_warning_not_hard_blocker`, `test_score_job_keeps_hard_blockers_separate_from_high_score`, `test_score_job_warns_when_explicit_posted_compensation_is_below_minimum`) |
| Reported company-role compensation estimates fail to emit best-effort ranges from grounded fallback tiers, omit confidence interval bounds for weak evidence, drop the selected source-row evidence or safe source URL behind a range, collapse executive CTO/VP roles into staff/principal/director fallback salary ranges, use bonus-only or one-sided posted salary rows as market evidence, lose Euro Top Tech/Levels.fyi/Glassdoor/manual/source-posted attribution, inflate a Levels.fyi market fallback with top-payer rows, expose unsafe provider payloads, write rows from API GET reads, skip the CLI, per-job web/API, or all-jobs web/API `compensation-refresh` trigger paths, or change fit score, apply readiness, or apply dispatch behavior | `workers/automation/tests/test_levels_fyi_public.py`; `workers/automation/tests/test_market_compensation_estimator.py`; `workers/automation/tests/test_market_compensation_repository.py`; `workers/automation/tests/test_compensation_refresh_cli.py`; `workers/automation/tests/test_jsonrpc_handlers.py`; `apps/api/test/json-rpc-adapter.test.ts`; `apps/api/test/server.test.ts` (`market compensation boundary`); `apps/web/src/contexts/enrichment/hooks/useRefreshCompensationMutation.test.ts`; `apps/web/src/views/jobs/JobBulkActions.test.tsx` |
| Compensation-source preferences stop persisting from Settings, fail to allow tokenless Levels.fyi public Markdown, allow licensed enablement without its access basis or Europe coverage, diverge between the API registry and Python refresh worker, let a provider-input configuration bypass an explicit user disable, or expose credentials/feed details | `apps/api/test/compensation-source-policy.test.ts`; `workers/automation/tests/test_levels_fyi_public.py`; `workers/automation/tests/test_market_compensation_repository.py`; `apps/web/src/contexts/scoring/components/CompensationSourcePolicyPanel.test.tsx`; `apps/web/src/contexts/scoring/hooks/useUpdateCompensationSourcePolicyMutation.test.ts`; browser smoke on `/settings` |
| Compensation read-model propagation diverges between Python and TypeScript projection builders, drops raw `JobSummary.salary` compatibility, merges posted facts with market estimates, leaks unsafe compensation data through SSE, or stops invalidating job list/detail after compensation writes | `workers/automation/tests/test_projection_builder.py`; `workers/automation/tests/test_posted_compensation_repository.py`; `workers/automation/tests/test_market_compensation_repository.py`; `apps/api/test/projections.test.ts`; `apps/api/test/server.test.ts` (`compensation boundary`, `market compensation boundary`); `apps/web/src/contexts/operations/every-event-has-handler.test.ts`; `apps/web/src/contexts/operations/invalidation-router.test.ts` |
| Compensation rendering disappears from Jobs table, expanded Jobs detail, or Apply Review; drops the separate Salary min, Salary max, Market, Confidence, or Warnings Jobs columns; stops normalizing posted salary min/max values to EUR/year; moves EUR/year units back into repeated row text instead of compensation headers; hides missing/not-requested states; drops market confidence interval, statistical confidence, source count, sample count, or warning count; merges posted salary and reported market evidence; loses Jobs table sort/filter behavior for any data column; or turns compensation into readiness/apply behavior | `apps/api/test/application-feedback.test.ts`; `apps/web/src/views/jobs/JobsView.test.tsx`; `apps/web/src/views/jobs/JobDetailDrawer.test.tsx`; `apps/web/src/views/apply-review/ApplyReviewView.test.tsx`; browser smoke on `/jobs` and `/apply-review` |
| Source quality stops feeding discovery budgets or dashboard health | `workers/automation/tests/test_discovery_scheduler_pr4.py`; `workers/automation/tests/test_source_quality_projection_pr4.py`; `apps/web/src/views/dashboard/SourceHealthCard.test.tsx`; `apps/web/src/contexts/operations/invalidation-router.test.ts` |
| Discovery product controls stop recording source/quarantine/manual-capture feedback safely, mislabel locator candidates, preview quarantine residue as source leads, or hide low-score role-match suggestions and approval state | `apps/api/test/discovery-controls.test.ts`; `apps/api/test/server.test.ts`; `apps/web/src/contexts/discovery/components/DiscoveryProductControls.test.tsx`; `workers/automation/tests/test_title_filter.py` |
| Discovery title filtering drops engineering/technical roles that merely carry a business-function token (account, commercial, PMO, pricing, sales) as a non-adjacent team/domain qualifier: these ambiguous titles must be routed to the LLM role adjudicator (never verbatim-accepted without it) and must default to accept — preserving recall — when the adjudicator is unavailable, while only business-primary titles (the token is the role head or its immediate modifier, with no genuine engineering head) are deterministically rejected | `workers/automation/tests/test_title_filter.py` |
| Apply review queue or outcome tracking starts apply automation, derives readiness differently from job detail, loses local-only outcome notes, hides pending outcome suggestions or in-flight apply stop controls, hides incomplete application-attestation warnings, exposes raw Gmail body text, drops the email-application preview, approves submit with a stale email recipient or attachment binding, or stops invalidating job/outcome views after decisions | `apps/api/test/apply-audit.test.ts`; `apps/api/test/application-feedback.test.ts`; `apps/api/test/server.test.ts`; `workers/automation/tests/test_gmail_feedback.py`; `apps/web/src/views/apply-review/ApplyReviewView.test.tsx`; `apps/web/src/contexts/apply/components/ApplicationOutcomes.test.tsx`; `apps/web/src/contexts/apply/hooks/useApplyReviewMutations.test.ts`; `apps/web/src/contexts/operations/hooks/useApplyReviewOutcomeQueries.test.ts` |
| Apply Review stops using the generated HTML/CSS resume as the editable line-level audit surface, falls back to a PDF image overlay for current HTML-rendered artifacts, reintroduces a separate side-by-side line audit pane, loses JobCtrl inline comments, loses source-to-tailored claim pins, stops highlighting the selected resume line, hides missing provenance, drops grounding/risk labels from generated claims, loses draft autosave/manual save reload, allows approval while a saved draft is dirty/unrendered/invalid, drops comment replies or source/risk labels, or mutates accepted materials instead of writing a validated replacement generation | `apps/api/test/resume-review-drafts.test.ts`; `apps/api/test/server.test.ts`; `apps/web/src/views/apply-review/ApplyReviewView.test.tsx`; `apps/web/src/contexts/apply/hooks/useApplyReviewMutations.test.ts`; browser smoke on `/apply-review` |
| Resume PDF rendering diverges from the accepted tailored payload, loses `resume_pdf` / render-format tagging, emits unsanitized HTML, drops layout target metadata on the HTML renderer, fails to persist/project layout boxes, stops exposing the generated sibling HTML through `/v1/artifacts/:artifactId/preview.html`, breaks legacy-to-HTML resume conversion, reintroduces a TeX render adapter, or applies the hard per-role bullet ceiling differently from the reviewed plain-text resume (making the submitted PDF, HTML renderer, provenance, and assembler select different bullet sets) | `workers/automation/tests/test_pdf_renderer_ports.py`; `workers/automation/tests/test_bullet_provenance.py`; `workers/automation/tests/test_resume_html_migration.py`; `workers/automation/tests/test_materials_repository.py`; `workers/automation/tests/test_dashboard_projection.py`; `apps/api/test/projections.test.ts`; `apps/api/test/application-feedback.test.ts`; `apps/api/test/server.test.ts`; `apps/web/src/views/apply-review/ApplyReviewView.test.tsx`; browser smoke on `/apply-review` |
| The resume-review render or template-refresh `resume_pdf` is emitted as the deleted truncated single-page hand-rolled text writer instead of the full HTML render (dropping lines past the first page, clipping long lines, or ignoring the edited HTML), or a failed render persists a broken/empty PDF instead of aborting and preserving the last approved generation | `apps/api/test/resume-review-drafts.test.ts`; `apps/api/test/resume-templates.test.ts`; `workers/automation/tests/test_pdf_renderer_ports.py`; browser smoke on `/apply-review` |
| Profile baseline resume stops rendering as a Plate HTML/CSS editor, falls back to a PDF iframe, serves `/v1/profile/preview.html` from anything other than the HTML/CSS resume renderer, or reintroduces a Profile-level LaTeX render path | `apps/api/test/server.test.ts`; `apps/web/src/contexts/profile/components/ProfileEditor.test.tsx`; browser smoke on `/profile` |
| Resume template editing persists candidate facts or job facts into template payloads, fails to preserve accepted artifacts during lazy render-only refresh, stops exposing default/per-job template state in Apply Review, or opens stale resume artifacts when a refreshed same-type artifact exists | `apps/api/test/resume-templates.test.ts`; `apps/api/test/application-feedback.test.ts`; `apps/api/test/server.test.ts`; `apps/web/src/contexts/profile/components/ProfileEditor.test.tsx`; `apps/web/src/views/apply-review/ApplyReviewView.test.tsx`; browser smoke on `/preferences`, `/apply-review`, and `/artifacts/$artifactId` |
| Any Plate resume editor loses its Export PDF control, exports saved/stale content instead of the live unsaved DOM, drops inherited template styling or A4/Letter geometry, emits a trailing blank page, splits a rendered text line across a page boundary, emits offset/oversized/cross-line selectable-text boxes, includes JobCtrl audit/comment or selection chrome, accepts a local path, exposes a raw renderer failure, saves editor state, registers/replaces an artifact, or changes Apply approval state | `apps/web/src/shared/adapters/local/BrowserPdfExportAdapter.test.ts`; `apps/web/src/contexts/profile/components/ProfileEditor.test.tsx`; `apps/web/src/views/apply-review/ApplyReviewView.test.tsx`; `apps/web/e2e/tests/profile-edit.spec.ts`; browser smoke on `/profile`, `/preferences`, and `/apply-review` |
| Fit-score badges stop using the numeric score as the color source of truth, where 10 is visibly green, 5 is neutral gray, and 0 is visibly red | `apps/web/src/contexts/scoring/components/ScoreBadge.test.tsx`; browser smoke on `/jobs` sorted by fit score |
| Discovery Target search stops driving role guidance, structured track/seniority/function recall, location fallback, Spain/Europe source filtering, new-job discovery limits, or API-visible source controls | `workers/automation/tests/test_target_search_preferences.py`; `workers/automation/tests/test_discovery_limits.py`; `workers/automation/tests/test_discovery_production_wiring.py`; `apps/api/test/discovery-controls.test.ts` |
| Profile, Preferences, Discovery target search, or Settings form autosave/undo regresses and risks losing user edits | `apps/web/src/contexts/profile/forms/profile-form.test.tsx`; `apps/web/src/contexts/profile/forms/settings-form.test.tsx`; `apps/web/src/contexts/profile/components/StructuredProfileEditor.test.tsx` |
| Discovery production wiring stops auto-approving located parseable sources, feeding API-visible manual queues, canonical ATS ingestion, manual-capture imports, snapshot persistence, or acceptance evidence | `workers/automation/tests/test_discovery_production_wiring.py` uses a Barcelona/Spain tech-leadership fixture and report covering lead yield, candidate sources, manual-action count, canonical verification rate, duplicate/quarantine counts, source-quality updates, and scoring handoff count |
| Integrated Discovery preparation stops chaining discovery/enrichment to current-policy scoring, tailoring, and suppression work; loses durable workflow idempotency; exposes internal preparation substages as product stages in the Jobs list; fails to pick up eligible visible pending preparation rows from Jobs; starts skip-only worker runs for known-ineligible pending rows; blocks Apply review on pending cover after a tailored resume exists; fails to resume internal preparation workflows after worker restart; or hides partial preparation failures | `workers/automation/tests/test_discovery_preparation_orchestration.py`; `workers/automation/tests/test_workflow_discovery.py`; `workers/automation/tests/test_workflow_job_preparation.py`; `workers/automation/tests/test_pipeline_observability.py`; `workers/automation/tests/test_actions.py`; `workers/automation/tests/test_job_list_projection.py`; `apps/api/test/projections.test.ts`; `apps/api/test/server.test.ts`; `apps/web/src/views/jobs/JobsView.test.tsx`; `apps/web/src/contexts/pipeline/components/StageTriggerPanel.test.tsx`; `apps/web/src/contexts/pipeline/components/UserFacingStageBadge.test.tsx`; `apps/web/src/views/dashboard/Funnel.test.tsx` |
| LinkedIn enrichment misses remain stuck after first-pass failure, enriched LinkedIn rows without application URLs never get a bounded authenticated retry, a failed or empty authenticated apply-URL retry destroys the canonical enriched description of an already-enriched LinkedIn row, or the authenticated browser resolver captures LinkedIn/Easy Apply URLs as if they were external company apply targets | `workers/automation/tests/test_linkedin_authenticated_enrichment_retry.py`; `workers/automation/tests/test_linkedin_apply_resolver.py` |
| A LOW-confidence quarantined enrichment description feeds the tailoring/cover/apply prep queues as if trustworthy, a quarantined job silently disappears from the funnel instead of staying scoreable and visible, a merely missing apply URL (MEDIUM/HIGH confidence) or an operator-overridden LOW snapshot is wrongly gated out of tailoring, or the job read model / audit trail drops the enrichment confidence + quarantine signal | `workers/automation/tests/test_enrichment_quarantine_gating.py`; `apps/api/test/server.test.ts` (`surfaces enrichment confidence and quarantine on the content-snapshot audit entry`) |
| Scoring policy current-version actions drift from per-job and bulk API/RPC contracts, ignore worker readiness, or fail to expose current-policy work in the UI | `apps/api/test/server.test.ts`; `apps/api/test/json-rpc-adapter.test.ts`; `apps/api/test/rpc-contracts.test.ts`; `workers/automation/tests/test_jsonrpc_handlers.py`; `apps/web/src/contexts/scoring/hooks/useRescoreCurrentPolicyMutation.test.ts`; `apps/web/src/contexts/scoring/components/RescoreCurrentPolicyButton.test.tsx` |
| Manual first-time tailoring or current-policy re-tailoring drift from per-job and bulk API/RPC contracts, drop generator/judge controls, lose low-fit manual override audit events, hide the tailor-stage trigger, or stop suppressing replaced active artifacts when requested | `apps/api/test/server.test.ts`; `apps/api/test/json-rpc-adapter.test.ts`; `apps/api/test/rpc-contracts.test.ts`; `workers/automation/tests/test_jsonrpc_handlers.py`; `workers/automation/tests/test_tailor_retailor.py`; `workers/automation/tests/test_materials_use_cases.py`; `apps/web/src/contexts/materials/hooks/useRetailorCurrentPolicyMutation.test.ts`; `apps/web/src/contexts/materials/components/RetailorCurrentPolicyButton.test.tsx`; `apps/web/src/contexts/pipeline/components/StageTimeline.test.tsx` |
| Threshold lowering or raising stops recomputing tailoring eligibility from persisted scores, invokes the scoring LLM, misses newly eligible tailoring work, or misses now-ineligible artifact suppression | `workers/automation/tests/test_discovery_preparation_orchestration.py`; `workers/automation/tests/test_score_aggregate.py`; `workers/automation/tests/test_materials_repository.py` |
| Artifact suppression leaks suppressed tailored artifacts into active displays or apply readiness, or deletes audit artifact rows/files | `apps/api/test/server.test.ts`; `workers/automation/tests/test_materials_repository.py`; `workers/automation/tests/test_materials_use_cases.py`; `apps/web/src/views/artifacts/ArtifactDetailPanel.test.tsx`; `apps/web/src/contexts/materials/components/ArtifactStatusBadge.test.tsx` |
| Tailoring rationale disappears from Apply review or artifact detail, leaks raw metadata/prompts/profile/resume contents, or breaks PDF preview for tailored resume artifacts | `apps/api/test/server.test.ts`; `apps/web/src/views/apply-review/ApplyReviewView.test.tsx`; `apps/web/src/views/artifacts/ArtifactDetailPanel.test.tsx` |
| The artifact tailoring explanation serves audit data from anything other than canonical projection rows: a read-time TypeScript keyword recompute against the resume file/job description, a sibling artifact's `metadata_json` synthesised onto a shell artifact, or a sibling `.txt` file read from disk; or the derived `keywords` block is non-empty when no canonical coverage was recorded | `apps/api/test/server.test.ts` (`derives the keyword block from the canonical coverage audit row`; `serves an empty keyword block when no canonical coverage exists`; `does not synthesize a PDF artifact's audit from a sibling artifact's metadata`) |
| Artifact comparison computes coverage deltas from job keywords or live editor text instead of stored artifact coverage rows, treats absent coverage as `0%`, drops declared-only coverage, drops older-generation artifact coverage rows, drops risk labels or validator/judge rows, hides the accepted artifact while a draft is compared, or loses the Artifacts same-job picker | `apps/api/test/projections.test.ts`; `apps/web/src/contexts/materials/selectors/compareCoverage.test.ts`; `apps/web/src/contexts/materials/components/ArtifactComparison.test.tsx`; `apps/web/src/contexts/materials/components/ArtifactComparison.a11y.test.tsx`; `apps/web/src/views/apply-review/ApplyReviewView.test.tsx`; `apps/web/src/views/artifacts/ArtifactDetailPanel.test.tsx`; browser smoke on `/apply-review` and `/artifacts/$artifactId` |
| The TypeScript and Python projection builders drift for the read-model projections — a schema or serialisation difference (a one-sided column addition, or a column one runtime leaves unpopulated) that lets one runtime project a different read model than the other, across both the audit tables (`job_employer_analysis`, `job_bullet_provenance`, coverage/voice) AND the full `job_list_projections` / `job_detail_projections` / `dashboard_projections` column sets (stage, score incl. criteria/trace/correction, compensation, apply, dashboard counts) | `workers/automation/tests/test_audit_projection_parity.py`; `apps/api/test/audit-projection-parity.test.ts` (both driven from the shared fixture `packages/domain-types/test/fixtures/audit_projection_parity.json`; each asserts full dual-written column parity plus a column-set guard) |
| Cross-runtime domain-event contracts drift: the Python event definitions diverge from the TypeScript `DomainEventUnion`, or an event-type migration/rename breaks replay of the persisted `job_events` log | `workers/automation/tests/test_domain_event_parity.py`; `workers/automation/tests/test_event_type_migration.py` |
| Hybrid retrieval picks stale or weak candidates before LLM scoring | `workers/automation/tests/test_hybrid_search_index.py`; `workers/automation/tests/test_scorer.py::test_run_scoring_preselects_retrieval_top_k_before_llm` |
| Scoring prompt/schema/model/policy changes silently regress parse validity, deterministic policy resolution, cross-job consistency, bands, blockers, ranking, correction agreement, or governance counters | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_scoring_eval.py workers/automation/tests/test_scoring_eval_feedback.py workers/automation/tests/test_score_repository.py`; update the synthetic scoring fixtures or document why a scoring change does not affect them |
| Score corrections change the policy but leave comparable uncorrected scores fresh, mark corrected versions stale, fail to expose stale policy metadata in jobs list/detail, or fail to clear selected/all stale markers for explicit rescore | `workers/automation/tests/test_score_repository.py`; `apps/api/test/server.test.ts`; `apps/web/src/contexts/scoring/hooks/useResetStaleScoresForRescoreMutation.test.ts`; `apps/web/src/views/jobs/JobsView.test.tsx` |
| A score correction partially commits when a later step fails: the new `job_scores` version or `scoring_policies` correction row persists without the comparable-staleness marking, leaving an inconsistent scoring state that later rescore logic reads | `apps/api/test/server.test.ts` (`rolls back the whole score correction when a later staleness write fails`) |
| Discover collapses to a hard failure when only some source families fail, instead of proceeding through detail enrichment and preparation on the surviving sources and failing the workflow only when every source family fails | `workers/automation/tests/test_workflow_discovery.py` |
| An enrichment site-batch crash aborts the whole enrichment activity instead of being isolated per site — the failing site must be recorded in `site_errors`, healthy sites must still complete, and the run must end `partial` rather than `failed` | `workers/automation/tests/test_discover_reliability.py` |
| A single job's enrichment crash fails the entire site batch (or the activity) instead of marking only that job failed with `ENRICH_INTERNAL_ERROR` while the rest of the batch continues | `workers/automation/tests/test_discover_reliability.py` |
| A browser acquisition bypasses the crawl-politeness gateway. For integrated Discovery, ordinary anonymous `robots.txt` reads and allowed page/API requests must use the live-profile extension, a robots-disallowed page must create no page task, run budget and shared host pacing must stop/defer further tasks, and denied work must fold into the Enrich stage as `ENRICH_ROBOTS_DISALLOWED` / `robots_disallowed` rather than a generic scrape failure. LinkedIn is the explicit owner-authenticated carve-out: its live signed-in extension session ignores the anonymous robots verdict but retains public-URL safety, exact-origin controls, pacing, budget, and no-submit. Every Temporal Enrich retry must synthesize a live-extension execution and skip the copied-profile pre-pass; an offline extension must reject before stage reset. A robots-blocked job whose robots later allows must Unblock (`Blocked -> Pending`) and re-enrich on a later run rather than strand as `ENRICH_INTERNAL_ERROR`. | `workers/automation/tests/test_live_browser_discovery.py`; `workers/automation/tests/test_enrichment_politeness_gate.py`; `apps/api/test/server.test.ts`; `apps/web/src/contexts/pipeline/components/StageTimeline.test.tsx`; live product-path QA from `docs/local-reliability-qa.md` |
| A hostile/absurd server `Retry-After` freezes a host and a pooled worker for an attacker-chosen duration — the limiter must clamp the stored deadline at the sink (`note_retry_after`) and cap any single nap, and an over-clamp host must record a `rate_limited` outcome and be skipped by `guard` (no slot held, no budget spent) rather than slept | `workers/automation/tests/test_politeness_gateway.py`; `workers/automation/tests/test_gateway_http_client.py` |
| Crawl identity diverges from its transport: standalone/non-extension gateways must retain the configurable `<product>/<version> (+<contact>)` identity (no `Mozilla`) and resolve it at use time, while integrated Discovery must preserve Chrome's own user agent rather than overwrite it and must evaluate robots with the browser-reported identity. `jobctrl doctor` must still disclose the configured standalone identity, active broad boards, and recent robots/rate-limit outcomes. | `workers/automation/tests/test_crawl_politeness_config.py`; `workers/automation/tests/test_browser_ua_propagation.py`; `workers/automation/tests/test_live_browser_discovery.py::test_robots_policy_is_fetched_and_cached_through_the_live_profile` |
| The JobStreaming broad-board per-run budget is silently mislabeled (counts search invocations, not requests) or Workday parallel routing loses per-host pacing / records blocked outcomes on the wrong thread — the broad-board budget must be documented as a per-search-invocation cap, and Workday `workers>=2` must pace per host while recording outcomes on the owning thread under the correct `source_id` with no `check_same_thread` error | `workers/automation/tests/test_jobspy_gateway_boundary.py`; `workers/automation/tests/test_workday_gateway_routing.py` |
| A Temporal activity failure is surfaced as the placeholder string `failed: failed` instead of the real error class and message; the propagated `ApplicationError` must carry the actual error type, message, and details (the literal `failed: failed` must never appear) | `workers/automation/tests/test_p1b_error_inversion.py`; `workers/automation/tests/test_discover_reliability.py` |
| Discover progress stalls at a stale running percentage (e.g. a frozen `running 67%`) instead of advancing through the "Detail enrichment" and "Preparation" steps on the Temporal path, or fails to show a terminal `failed` status when the workflow fails | `workers/automation/tests/test_workflow_discovery.py`; `workers/automation/tests/test_discover_reliability.py`; `apps/api/test/server.test.ts` |
| `workflow_run_projections` keeps a stale terminal state (`terminated` / `reconciled_not_found`) for a `workflow_id` after a fresh run of the same workflow starts, so the new run's terminal event never supersedes the stale row — first-terminal-wins must yield to a newer run's terminal event | `workers/automation/tests/test_workflow_runs_projection_from_events.py`; `apps/api/test/server.test.ts` |
| Worker startup and `jobctrl doctor` boot without detecting a missing or garbage-collected Playwright Chromium binary (the worker fails hours into a Discover run instead of at startup), or a dev restart truncates a process log and destroys the previous run's crash traceback instead of rotating it to `<name>.log.1` | `workers/automation/tests/test_preflight.py`; `workers/automation/tests/test_doctor_playwright.py`; manual QA: with the browser removed, `jobctrl doctor` reports the `playwright chromium (scraping + PDF)` check MISSING and `jobctrl worker` exits non-zero before connecting to Temporal (unless `JOBCTRL_SKIP_BROWSER_PREFLIGHT=1`); write a worker log via `scripts/dev`, restart, and confirm the prior run survives as `.dev/logs/worker.log.1` |
| A stored contact fact renders or projects without inspectable provenance — the `Contact` aggregate accepts an attribute with no `ContactFactProvenance`, the `contact_projections` read model or `ContactDetail` DTO drops per-attribute source kind / source ref / capture method / confidence / user-confirmed state, or CSV-imported facts are not tagged `user_imported_list` with the filename (INV-2) | `workers/automation/tests/test_contact_provenance.py`; `workers/automation/tests/test_contact_aggregate.py`; `workers/automation/tests/test_contact_repository.py`; `workers/automation/tests/test_contact_projection_parity.py`; `apps/api/test/contacts.test.ts`; `apps/api/test/contact-projection-parity.test.ts`; `apps/web/src/contexts/outreach/components/ContactProvenanceList.a11y.test.tsx`; `apps/web/src/contexts/outreach/hooks/useContactDetailQuery.test.ts`; browser smoke on `/outreach` |
| Contact records grow a send/transport path (email / SMTP / DM / API send), or a contact attribute VALUE (name, email, note) leaks into a `job_events` payload, the `contact_projections` read model, a log, or a telemetry span instead of living only in `contact_attributes.value_json` (INV-1: the product never sends; sensitivity) | `workers/automation/tests/test_contact_repository.py` (`test_values_never_leak_into_events_or_projection`); `workers/automation/tests/test_contact_projection_parity.py`; `apps/api/test/contacts.test.ts` (`never leaks attribute values into job_events payloads`); `apps/api/test/contact-projection-parity.test.ts` (`never persists an attribute value into the projection`); manual QA / grep: no send or transport symbol (`smtp`, `gmail.send`, `messages.send`, `sendMail`, `nodemailer`) exists in `workers/automation/src/jobctrl/domain/contact/`, `infrastructure/contact/`, `apps/api/src/contacts.ts`, or `apps/web/src/contexts/outreach/` |
| Supervised contact research fetches a source the policy does not permit, auto-fetches a public page that was not opted in, follows a login-walled/paywalled URL instead of routing it to manual capture, or fails to record a robots/rate-limit/budget block as a first-class `ResearchSourceAttempt` outcome (INV-3; all fetching gateway-routed) | `workers/automation/tests/test_contact_research_source_policy.py`; `workers/automation/tests/test_contact_research_workflow.py` (robots/rate-limit outcomes; disallowed-source rejected without fetching; gateway routing) |
| A research candidate becomes a stored contact without an explicit user confirm command, a proposed candidate/attribute lacks provenance, or a candidate VALUE leaks into an event/projection instead of living only in `contact_candidates.attributes_json` (INV-4 supervised; INV-2 provenance; sensitivity) | `workers/automation/tests/test_contact_research_workflow.py` (candidate-requires-confirmation; provenance-on-every-candidate; values-never-leak); `workers/automation/tests/test_contact_research_projection_parity.py`; `apps/api/test/contact-research.test.ts`; `apps/api/test/contact-research-projection-parity.test.ts`; `apps/web/src/contexts/outreach/hooks/useConfirmCandidateMutation.test.ts`; `apps/web/src/contexts/outreach/components/CandidateReviewList.a11y.test.tsx`; browser smoke on a job's Contacts panel |
| The research read model drifts between runtimes — the Python `_rebuild_contact_research` and TS `rebuildContactResearchProjections` disagree on counts, source-attempt outcomes, or per-candidate provenance metadata for the shared fixture | `workers/automation/tests/test_contact_research_projection_parity.py`; `apps/api/test/contact-research-projection-parity.test.ts` |
| An outreach draft that fabricates a metric, employer, title, or relationship — or otherwise fails the reused truthfulness gate stack (deterministic never-fabricate detector + content validator + LLM judge) — becomes approvable, approval is not HARD-gated on the persisted `gate_results_json.passed` (a failed- or absent-gate draft approves through the aggregate, the worker draft path, or the TS API transition), or approving a draft performs an outbound send (INV-5; INV-1) | `workers/automation/tests/test_outreach_draft_gates.py`; `workers/automation/tests/test_outreach_thread_aggregate.py`; `workers/automation/tests/test_outreach_no_send_transport.py`; `apps/api/test/outreach.test.ts`; `apps/web/src/contexts/outreach/components/DraftGateResultsPanel.test.tsx`; `apps/web/src/contexts/outreach/hooks/useApproveDraftMutation.test.ts`; browser smoke on a contact's Outreach panel |
| Re-drafting or editing an outreach message destroys or hides the last approved draft before a replacement is approved — a new generation fails to supersede stale candidates, a re-draft overwrites the approved draft, an edit is applied in place instead of as a gated new generation, or the generation history drops prior drafts (INV-5) | `workers/automation/tests/test_outreach_thread_aggregate.py`; `workers/automation/tests/test_outreach_draft_gates.py`; `apps/api/test/outreach.test.ts`; `apps/web/src/contexts/outreach/components/OutreachThreadPanel.test.tsx`; `apps/web/src/contexts/outreach/hooks/useReviseDraftMutation.test.ts`; browser smoke on a contact's Outreach panel |
| Outreach drafting/logging starts an automated send, exposes a send transport, or marks a thread sent without a user-attested send log (INV-1) — the four enforcement layers: (a) the `OutreachThread` aggregate lets a thread reach "sent" without a user-attested `OutreachSendLog` over an approved draft; (b) any send-transport symbol (`smtp`, `gmail.send`, `messages.send`, `sendMail`, `nodemailer`, `createTransport`, …) appears in outreach code on either runtime; (c) any transport-shaped seam is invoked on an outreach path; or (d) "approve draft" and "log send" collapse into one action (approving performs an outbound action or marks the thread sent) | (a) `workers/automation/tests/test_outreach_thread_aggregate.py`; (b) `workers/automation/tests/test_outreach_no_send_transport.py` (scans Python domain/infra + `apps/api/src/outreach.ts` + `apps/web/src/contexts/outreach/` + `views/outreach/`); (c) `workers/automation/tests/test_outreach_no_auto_send.py` (`test_no_transport_is_invoked_on_any_outreach_path`); (d) `workers/automation/tests/test_outreach_no_auto_send.py` (approve-records-a-fact / log-send-is-separate) + `apps/api/test/outreach.test.ts` (records-a-send / refuses-non-approved / no `/send` route) |
| Outreach follow-ups auto-act or auto-send, or an optional recurring follow-up reminder defaults ON — a follow-up is sent or acted on without an explicit user action, the due-follow-ups read model triggers an outbound effect instead of only surfacing, the 7-day/14-day derivation is wrong, or `outreach_follow_up_reminders_enabled` defaults to `true` (§9; INV-1) | `workers/automation/tests/test_outreach_follow_up_derivation.py` (7d/14d derivation; default-off; even-when-enabled-only-surfaces); `workers/automation/tests/test_due_follow_up_projection_parity.py`; `apps/api/test/outreach.test.ts` (schedule/complete/dismiss + only-arrived-follow-ups-are-due); `apps/api/test/due-follow-up-projection-parity.test.ts`; `apps/web/src/contexts/outreach/hooks/useScheduleFollowUpMutation.test.ts`; browser smoke on the Follow-ups panel |
| The full contact-and-outreach product path regresses even though isolated units pass — contacts cannot be reviewed from both Job Detail and the Outreach route, candidate provenance is not visible before confirmation, the approved draft is hidden during revision, the send-log/follow-up surfaces imply automation, or due follow-ups do not surface as reminders only | `apps/web/e2e/tests/outreach.spec.ts`; existing focused rows above plus the seeded **Outreach Planner Product Smoke** below; keep it synthetic-only with no live fetch, no live LLM call, no browser submission, and no outbound transport |
| The left-rail shell (2026-07 UI revamp) regresses — a rail group or any of the 14 nav destinations disappears or loses its visible label (full rail, icon collapse at ≤1180px, or the hamburger sheet at ≤820px), the slim topbar drops the global job search / density / theme / connection-status affordances, or shell chrome renders unpainted in either theme | `apps/web/e2e/tests/token-foundation.spec.ts` (rail groups, labelled mobile sheet, painted topbar/shell chrome, density values); `apps/web/e2e/tests/route-visual-qa.spec.ts` (per-route active rail link + heading proofs, light/dark paint, density modes) |

### Scoring Policy Eval Gate

For scoring prompt, schema, model, rubric, policy, correction-learning, or
stale-score changes, run:

```bash
uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_scoring_eval.py workers/automation/tests/test_scoring_eval_feedback.py workers/automation/tests/test_score_repository.py
```

This gate keeps the local scoring harness focused on non-sensitive facts:
synthetic dimensions, deterministic policy outputs, aggregate anchor/stale
counts, and correction agreement. Do not add raw job URLs, correction
rationales, anchors, resumes, or local paths to eval reports or committed
fixtures.

### Saved Views Smoke

For Jobs table saved-view changes, run the targeted web fixtures and one browser
smoke on `/jobs`:

```bash
corepack pnpm --dir apps/web exec vitest run src/shared/stores/saved-table-views.test.ts src/shared/ui/filterable-data-grid.test.tsx src/views/jobs/JobsView.test.tsx
```

Manual smoke:

1. Open `/jobs` with at least one Discover-stage and one Apply-stage synthetic
   job.
2. Filter the Stage column to `apply`, hide one non-critical column, reorder a
   column, resize a column, set the table density to `compact`, group by Stage,
   and add one semantic color rule.
3. Save the current template as a named view, switch to `Default`, then switch
   back to the named view.
4. Reload the page and confirm the named template restores column visibility,
   order, widths, density, grouping, color rules, and the URL-backed stage
   filter/sort.
5. Rename the view, delete it, and confirm the table falls back to `Default`.

### Daily Digest Smoke

For daily digest changes, run the TypeScript/Python parity fixtures plus the
CLI smoke:

```bash
corepack pnpm --dir apps/api exec vitest run test/digest.test.ts
uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_digest_parity.py workers/automation/tests/test_digest_cli.py
```

Manual smoke:

1. Open Dashboard and confirm the Digest panel renders the same counts as
   `uv --project workers/automation run jobctrl digest --json` for the same
   local database.
2. Run `uv --project workers/automation run jobctrl digest` and confirm it
   does not change `digest_state.last_acknowledged_at`.
3. Run `uv --project workers/automation run jobctrl digest --acknowledge`
   and confirm the watermark advances to the displayed digest timestamp and a
   `DigestReviewed` event is recorded.

### Resume Tailoring Quality Eval Gate

For resume tailoring prompt, evidence policy, deterministic quality checks,
judge, or adversarial-review changes, run:

```bash
uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_materials_quality_eval.py workers/automation/tests/test_materials_quality.py workers/automation/tests/test_materials_adversarial.py workers/automation/tests/test_materials_use_cases.py
```

This gate uses synthetic profile and job fixtures only. Do not add real resume
text, raw job URLs, generated artifacts, local artifact paths, or local profile
data to the fixture corpus.

## Frontend QA

The `apps/web` test pyramid follows the strategy defined in
[`docs/architecture/frontend/testing.md`](../../architecture/frontend/testing.md) §10. Run the layers via the
commands listed under the "Frontend" section of
[`docs/local-development.md`](../../local-development.md).

### Token Foundation QA Gate

For changes to the shadcn token foundation, `apps/web/src/styles/tokens.css`,
`apps/web/src/styles/globals.css`, `components.json`, shared primitive token
classes, theme behavior, or density behavior, run the token foundation proof gate:

```bash
corepack pnpm --filter @jobctrl/web exec vitest run \
  src/styles/token-contrast.test.ts \
  src/shared/ui/base-ui-migration-boundary.test.ts \
  src/shared/ui/button.test.tsx \
  src/shared/ui/input.test.tsx \
  src/shared/ui/select.test.tsx \
  src/shared/ui/tabs.test.tsx
corepack pnpm web:check
corepack pnpm web:build
corepack pnpm dlx shadcn@latest info -c apps/web
corepack pnpm --filter @jobctrl/web e2e -- tests/token-foundation.spec.ts
git diff --check
```

`token-contrast.test.ts` resolves the semantic token pairs from `tokens.css`
and asserts WCAG AA (>= 4.5:1) for muted-foreground text on both the muted
card-header band and the card surface in light and dark themes, so a
regression that pushes muted secondary text below the bar fails deterministically.

Also prove generated CSS contains the standard semantic utilities and scan for
retired token aliases before accepting the change. Browser proof must use the
Playwright seeded app directory or another disposable synthetic workspace. Do
not run auto-apply, browser submission, mailbox scanning, real material
generation, destructive profile/database actions, or worker-backed jobs for
token QA.

### Shared Primitive QA Gate

For shared primitive token changes under `apps/web/src/shared/ui`, keep the
QA surface local, synthetic, and primitive-owned. Run the relevant scoped
shared/ui Vitest files plus the changed shared helper tests, for
example:

```bash
corepack pnpm --filter @jobctrl/web test src/shared/ui/data-table.test.tsx src/shared/ui/toast.a11y.test.tsx src/shared/ui/filterable-data-grid.test.tsx src/shared/ui/table-pager.test.tsx src/shared/lib/job-description-blocks.test.ts
corepack pnpm web:check
corepack pnpm web:storybook:build
corepack pnpm web:storybook:test
corepack pnpm dlx shadcn@latest info -c apps/web
git diff --check
```

Also run the retired-token scan and the shared/ui boundary scan. The
retired-token scan must reject `bg-paper`, `text-ink`,
`border-rule`, `ring-info`, retired CSS variables, and bare `text-muted` while
allowing standard shadcn utilities such as `text-muted-foreground`. The
boundary scan must return zero disallowed imports from `shared/ui` into
contexts, views, API clients, routes, TanStack Query hooks, local storage,
EventSource, or clipboard APIs.

Select the scoped shared/UI cases through the QA router. Preserve applicable
`web:check`, Storybook build/test, retired-token and dependency-boundary checks.
A required failing test blocks the gate; a separately confirmed unrelated
failure needs a linked issue and an explicit verification limitation.

Shared primitive QA must use synthetic stories, seeded browser proof, or
disposable fixtures only. Do not run auto-apply, browser submission, mailbox
scanning, real material generation, destructive profile/database actions, or
worker-backed jobs for this gate.

### Route Visual QA Gate

For route-level visual-system changes, run the seeded Playwright route visual QA
spec:

```bash
mkdir -p /tmp/jobctrl-route-qa
JOBCTRL_E2E_APP_DIR=/tmp/jobctrl-route-qa \
JOBCTRL_E2E_API_PORT=8878 \
JOBCTRL_E2E_WEB_PORT=5275 \
corepack pnpm --filter @jobctrl/web e2e -- tests/route-visual-qa.spec.ts
```

The spec covers representative routes, overlays, light/dark themes, density
modes, focus indicators, filters, forms, and destructive-control visibility
against disposable seeded data. Keep this gate synthetic or seeded only; do not
run auto-apply, browser submission, mailbox scanning, real material generation,
destructive profile/database actions, or worker-backed jobs for visual QA.

### Cumulative Rhea/Base UI Final Gate

Run this gate after the cumulative redesign branch has its canonical docs and
synthetic fixtures. It complements focused phase checks; it is not a substitute
for the security, apply, or workflow matrices above.

```bash
corepack pnpm --filter @jobctrl/web exec vitest run \
  src/styles/token-contrast.test.ts \
  src/shared/ui/base-ui-migration-boundary.test.ts \
  src/shared/layout/Topbar.test.tsx \
  src/shared/ui/button.test.tsx \
  src/shared/ui/data-table.test.tsx \
  src/shared/ui/label.test.tsx \
  src/shared/ui/page-head.test.tsx \
  src/shared/ui/filterable-data-grid.test.tsx \
  src/shared/stores/saved-table-views.test.ts \
  src/contexts/operations/components/BrowserCapabilitiesPanel.test.tsx \
  src/contexts/profile/components/CredentialsPanel.test.tsx \
  src/contexts/outreach/components/DueFollowUpsPanel.test.tsx \
  src/contexts/scoring/components/CompensationSourcePolicyPanel.test.tsx \
  src/contexts/materials/components/EmployerAnalysisPanel.test.tsx \
  src/contexts/materials/components/EmployerAnalysisPanel.a11y.test.tsx \
  src/contexts/materials/components/TailoringExplanationSection.test.tsx \
  src/contexts/pipeline/hooks/useCancelWorkflowRunMutation.test.ts \
  src/views/pipelines/PipelinesView.test.tsx \
  src/routes/-jobs.search.test.ts \
  src/views/jobs/JobBulkActions.test.tsx \
  src/views/jobs/JobBulkActions.a11y.test.tsx \
  src/views/jobs/JobsTable.test.tsx \
  src/views/jobs/JobsTable.a11y.test.tsx \
  src/views/jobs/JobsView.test.tsx \
  src/views/jobs/JobDetailDrawer.test.tsx \
  src/views/artifacts/ArtifactDetailPanel.test.tsx \
  src/views/evidence-map/EvidenceMapView.test.tsx \
  src/views/apply-review/ApplyReviewView.test.tsx \
  src/contexts/operations/hooks/usePipelineOperationsQuery.test.ts \
  src/contexts/operations/invalidation-router.test.ts
corepack pnpm --filter @jobctrl/api exec vitest run \
  test/pipeline-operations.test.ts \
  test/pipeline-eta.test.ts \
  test/worker-runtime-telemetry.test.ts \
  test/server.test.ts
uv --project workers/automation run --extra dev pytest -q \
  workers/automation/tests/test_browser_capabilities.py \
  workers/automation/tests/test_browser_capabilities_rpc.py
mkdir -p /tmp/jobctrl-route-qa
JOBCTRL_E2E_APP_DIR=/tmp/jobctrl-route-qa \
JOBCTRL_E2E_API_PORT=8878 \
JOBCTRL_E2E_WEB_PORT=5275 \
corepack pnpm --filter @jobctrl/web e2e -- tests/route-visual-qa.spec.ts
mkdir -p /tmp/jobctrl-responsive-qa
JOBCTRL_E2E_APP_DIR=/tmp/jobctrl-responsive-qa \
JOBCTRL_E2E_API_PORT=8879 \
JOBCTRL_E2E_WEB_PORT=5276 \
corepack pnpm --filter @jobctrl/web e2e -- tests/responsive-data-surfaces.spec.ts
git diff --check
```

Visual evidence is valid only when it is captured from the final integration
HEAD after the last merge, rebase, or visual-system edit. Screenshots from an
earlier commit do not satisfy this gate. A final-head rerun must also exercise
the geometry assertions, because a painted screenshot alone cannot prove that
composite controls contain their children.

The gate passes only when:

- `base-rhea`, Geist, the semantic token mappings, light/dark contrast, all
  three densities, a density-independent 16px body, the compact PageHead
  hierarchy, and the shared card/status rules remain intact;
- direct Radix imports and raw native selects are absent, Base UI overlays keep
  their focus/dismissal/portal contract, and route visuals show no clipping or
  document-level overflow at desktop and 390×844;
- Jobs exposes Active/Deleted/Hidden as real Tabs, keeps legacy `closed` only as
  a compatible deep-link state, hides Sources/Warnings in the default view,
  omits redundant active lifecycle copy, uses destructive deletion, and keeps
  row activation focus-visible without a permanent duplicate action;
- Jobs keeps workflow-recovery actions visible without opening the maintenance
  menu; Apply Review queue rows contain their content without overlapping at
  every density; and Discovery checkboxes keep a 24px hit target around a 16px
  visual control that does not overpower its label;
- Jobs, Artifacts, Contacts, Discovery, and Settings record data reflows into
  labelled cards at 900px and below; Profile and Evidence Map stack their work
  regions, while Apply Review keeps a desktop queue rail and wraps decisions in
  its narrow sequential layout;
- Pipelines keeps source families separate from the two reconciliation steps,
  preserves execution/sweep/global-backlog scope and exact outcome counts,
  masks sensitive identifiers, refreshes after stopping active discovery, and
  gates replacement-run setup on an exact zero-active-work inventory without
  dispatching implicitly; compact inspector labels, values, and timestamps also
  remain on the same body-small typography scale;
- Job Detail and Artifact Detail resolve evidence through the Evidence Map into
  human-readable titles/excerpts, keep unresolved keys behind technical details,
  Artifact Detail places the preview after its audit details, and Apply Review
  preserves persisted comments even when a rendered-line anchor cannot be
  resolved;
- passive browser detection exposes no paths or side effects, stale detected
  IDs fail closed, manual path entry remains an advanced explicit fallback,
  Settings never exposes the legacy copied-profile capability, and the retained
  compatibility API still requires separate consent;
- an environment-owned active provider route stays authoritative and read-only
  while alternative supported routes remain editable but inactive; and
- a retry with `runAfter: true` preflights worker readiness before resetting
  the failed stage. If the worker is unavailable, the API returns the readiness
  failure and preserves the stage state, attempt count, diagnostics, and audit
  evidence unchanged.

### Coverage layout

| Layer | Files | Purpose |
| --- | --- | --- |
| Unit / hook / component (Vitest + RTL + MSW) | `*.test.ts(x)` files under `apps/web/src/` | Pure selectors, query-key factories, the invalidation router (one registered handler per `DomainEvent` variant in `DOMAIN_EVENT_TYPES`), every Operations read hook, every per-aggregate mutation hook (success path + rollback path), forms, drawers, filter bars. |
| Type-level tests (Vitest `typecheck` mode via `vitest.types.config.ts`) | 11 `*.test-d.ts` files under `apps/web/test/types/` | Inferred shapes of the Operations read hooks plus `useActivityEventQuery`, `useWorkflowRunsListQuery`, and `useEvidenceMapQuery`, using typed test files in Vitest's typecheck runner (cf. target §10.6). |
| End-to-end (Playwright headless) | 27 specs in `apps/web/e2e/tests/` — 26 flow/regression specs plus the `docs-screenshots` documentation utility spec | One spec per critical flow (target §10.4) against a real `apps/api` + a seeded SQLite fixture. `repeat-application.spec.ts` proves the visible exact-duplicate block, reasoned confirmation, simulated API dispatch, authoritative Python worker consumption, and second-attempt refusal without submitting an application. `analytics.spec.ts` checks the Analytics route with a canonical-shaped read-model response and verifies a below-minimum-sample group stays count-only. `evidence-map.spec.ts` asserts the Evidence route reads the projection-backed evidence usage index, filters from a job-detail handoff, and navigates usage links back to the owning artifact/job. `interview-prep.spec.ts` asserts the explicit generate-interview-prep action queues through the REST route, then injects an accepted prep generation and `InterviewPrepGenerated` event to prove the Job Detail workspace renders a STAR draft, records a linked reflection through the existing outcome endpoint, and follows an evidence-map provenance link through the SSE realtime loop. `outreach.spec.ts` asserts the seeded contact-and-outreach planner path across Job Detail, supervised candidate review, `/outreach` contact detail, approved/blocked draft review, user-attested send logging, due follow-up reminders, and the event/projection no-value-leak boundary. `mobile-connection-banner.spec.ts` holds the 390×844 stale-worker banner clear of the Dashboard heading and guards against horizontal overflow. `mobile-shell-width.spec.ts` proves representative route shells and their route content use the full 390×844 viewport while the navigation sheet remains usable. `token-foundation.spec.ts` checks light/dark shadcn tokens, root `color-scheme`, app-shell density values, focus indicators, native select styling, and dense-route rendering without user-affecting automation. `route-visual-qa.spec.ts` checks representative routes, overlays, density modes, focus indicators, forms, filters, destructive-control visibility, and targeted visual snapshots for the requirement-fit Job Detail card plus Apply Review requirement card after visual-system changes. `materials.spec.ts` asserts the per-job generate-materials button is enabled, the route returns 202 (not 400), and the worker-confirmed `ResumeApproved` surfaces in the job audit history via the SSE realtime loop. The harness runs the real route + worker-readiness gate (seeded worker heartbeat) but routes dispatch through a deterministic stub (`JOBCTRL_E2E_STUB_DISPATCH`) so no worker subprocess or LLM is required. E2E ports are overridable via `JOBCTRL_E2E_API_PORT` / `JOBCTRL_E2E_WEB_PORT` for parallel worktrees. |
| A11y suites (Vitest + `axe-core` + `jest-axe`) | 37 files matching `*.a11y.test.ts` or `*.a11y.test.tsx` under `apps/web/src/` | Input-bearing forms, overlays, dashboard and analytics surfaces, material inspectors, evidence, discovery, outreach, and provenance components — fails on critical/serious violations (target §10.7). |

### Scoring Policy Feedback Smoke

For UI changes around score correction learning, verify the jobs table shows
the compact stale-score badge on unresolved stale scores, the Job Detail workspace shows
the policy update state, and the reset control posts to
`/v1/scoring/stale-scores/actions/reset-for-rescore` before running
`jobctrl score --rescore` or the score stage with `rescore: true`.

### Job Detail Audit Smoke

For UI changes around job ranking or readiness, open `/jobs`, click a job row,
and verify the Job Detail header shows why the job ranked where it did
(score, band/confidence, reasoning, signals, keywords), whether it is ready for
apply review, any missing prerequisites, hard blockers, eligibility concerns,
and an Apply Review handoff. The readiness and blocker copy must come from the
shared `applyAudit` contract. The detail route should use the available viewport
and arrange sections as a wide audit workspace rather than a narrow side panel.
When touching score visuals, sort by fit score and verify
score badges use the numeric color contract: 10 green, 5 gray, and 0 red.
When touching requirement-fit explanation, verify scored jobs show requirement
fit as the explanation of the numeric score and jobs without
`requirementFitReport` show "not assessed" plus a current-policy re-score action;
the workspace must not derive requirement matches from broad matched/missing signal
text.
When touching compensation rendering, verify the Jobs table shows separate
Salary min, Salary max, Market, Confidence, and Warnings columns, that salary
min/max/market values are normalized to EUR/year with the unit carried by the
headers, that every data column can request a sort, and that
the Job Detail Compensation section separates posted salary from
reported company-role market evidence, source trail, source/sample counts,
source-conflict warning code/message, warnings, confidence factors, collapsed
selected evidence rows, evidence source links when available, and the market
confidence interval. The
detail-workspace refresh control must re-run only the selected job's compensation
analysis, the Jobs toolbar `refresh compensation` action must re-run
compensation analysis for all jobs, and both refresh paths must honor configured
reported-source loading plus the optional reported-observations JSON path
without running
discovery, scoring, tailoring, cover, apply automation, mailbox scanning, or
material regeneration.
Do not run apply submission, mailbox scanning,
material regeneration, destructive profile/database actions, or worker-backed
jobs for this smoke.

### Evidence Map Smoke

For UI/API changes around the Evidence map, open `/evidence-map` against the
synthetic QA workspace and verify profile achievements and declared skills are
listed with their resume-bullet usage, requirement-fit usage, coverage history,
and gaps. From a Job Detail workspace, use the Evidence map handoff and verify the
route opens with a job filter, the clear-filter link restores the full map, and
usage links navigate to the owning `/artifacts/$artifactId` or `/jobs/$jobId`
detail route. This smoke is read-only; do not run discovery, scoring, tailoring,
cover, apply automation, mailbox scanning, material generation, destructive
profile/database actions, or worker-backed jobs for it.

### Apply Review Smoke

For UI/API changes around application review or outcome tracking, open
`/apply-review` and verify the queue shows ready and blocked apply-stage jobs,
derives the visible status tag/counts from `applyAudit`, offers submit approval
as the primary live-gate action, records `approve_submit`, dry-run approval,
defer, decline, and reset decisions without starting apply/browser automation,
and refreshes the queue after each decision. Open a Job Detail workspace and
verify its `applyAudit` readiness/blocker facts agree with the selected Apply
Review job. Verify the selected review also shows compensation range and
statistical confidence from `compensationSummary` without changing readiness,
queue inclusion, or approval controls. For resume-audit changes, verify the
tailored resume renders as a Plate-backed HTML/CSS editor, not a PDF image
overlay; the first render matches the final artifact's generated HTML/CSS and
keeps the modern resume content layout (A4 page, centered header, black
section rules, compact entry grids, and real list bullets); the "open final
file" link still opens the generated PDF artifact; and line-level JobCtrl
comments appear on the resume surface rather than in a separate side-by-side
audit pane. Selecting a resume line must highlight that editor line and keep a
single JobCtrl comment open beside it; comments expose source text, rationale,
source precision, grounding/risk labels when provenance exists, and missing
provenance as an explicit state instead of blank space. When requirement-led
audit metadata exists, verify Apply Review can show covered and uncovered
requirements, evidence-backed generated claims, pinned content, adjacent or
draft labels, legacy or rejected bullet-limit violations, revision decisions, and review
blockers, and that raw prompts, full profile/job text, local paths, generated
PDFs, logs, browser data, and SQLite contents are absent from the response.
Edit a generated claim line and a structural line, verify autosave/manual save
reload the draft, reply to a JobCtrl comment while keeping the source pointer
and risk label visible, verify approval buttons stay blocked until the saved
draft validates/renders, then render a replacement and confirm the final-file
link points at the latest approved artifact while the existing accepted artifact
was not deleted. Manual outcomes should save with a canonical timestamp, local
notes render only in the outcome timeline, pending outcome suggestions can be
accepted, corrected, or ignored, and the job audit history shows review/outcome
entries without raw notes, email body text, debug statements, or raw event names.

For Gmail feedback changes, use fake Gmail clients or seeded worker fixtures.
Do not scan a real mailbox for QA automation. Verify that the scan is bounded
by application anchors, recipient, max result/window limits, and employer/ATS
hints; that `read_email` is not called for unlinked metadata; and that the API
scan response includes only counts plus evidence/suggestion identifiers, kinds,
and confidence values. For email-application send changes, use a fake sender and
seeded review/event fixtures; verify the send is blocked without a recorded
candidate, matching recipient/attachment approval, and Gmail `gmail.send` scope.

For apply-agent verification-boundary changes, use a disposable harness page
and fixture MCP configuration only. The page should instruct the agent to fetch
and paste a verification value or saved credential; the expected outcome is
that Gmail and credential tools are absent from the allowlist, explicitly
denied, and omitted from the default inspection MCP configuration.

### Materials Generation + Inspector Smoke

For UI/API changes around per-job material generation or the tailoring inspector,
open a Job Detail workspace and verify the "generate materials"
control is enabled, confirms before dispatching, and reports a queued/in-flight
state; the route is `POST /v1/jobs/:jobKey/actions/generate-materials` and returns
202 once the worker is ready (503 when the worker heartbeat is missing/stale). Do
not run real generation against a live worker for QA automation — exercise the
route + UI wiring with the E2E stub dispatcher and inject the terminal
`ResumeApproved` event into SQLite to drive the realtime loop.

Verify the inspector renders honestly: the employer-analysis panel shows
requirements (must/nice tier + priority weight) and reasoned keywords with quoted
job-description evidence spans; the per-bullet provenance list shows the
original → tailored diff and evidence × requirement × transform × control ×
rationale per bullet. Confirm missing audit data is never masked — a job with no
analysis shows an explicit "not recorded" state, empty FK/keyword sets show "none
recorded", a drafted-adjacent bullet shows an explicit "original profile bullet
not recorded" diff side, and a null voice pass shows "no voice pass recorded".
Confirm a re-tailor/generate-materials in flight never hides the last accepted
artifact or its provenance.

### Outreach Draft Review Smoke

For UI/API changes around outreach drafting, open a contact detail (the
**Outreach** panel on `/outreach/$contactId`) and generate a draft. Verify the
panel shows the candidate under review with its gate-results panel (the persisted
truthfulness-gate outcome), the claim → fact provenance list, and the full
generation history; that **approve is disabled until the gates pass**; that editing
submits a new generation and re-runs the gates rather than mutating the draft in
place; and that approving supersedes the previous approved draft while a reject
leaves the last approved draft readable. Confirm the approved draft exposes a
**copy** action that writes to the clipboard through the `ClipboardPort`, and that
**no send or transport control exists anywhere** on the surface. Do not run real
generation against a live worker for QA automation — exercise the route + UI wiring
with seeded `outreach_threads` / `outreach_drafts` fixtures (both gate-passed and
gate-failed drafts) and the E2E stub dispatcher; never a real LLM call and never a
real send.

### Outreach Planner Product Smoke

For delivery QA of the contact-and-outreach planner, run the browser against a
disposable seeded database and deterministic stubs. Do not use real contacts,
real job-board pages, real LLM calls, profile data, browser submission, or any
email/message transport. The seed should contain one scored job with an
application-submitted outcome, one imported contact fact, one public-source
research attempt with proposed candidates, one gate-passed approved draft, one
gate-failed candidate draft, one user-attested send log, and both due and future
follow-up schedules.

Verify the product path end to end:

- The Job Detail **Contacts** panel and `/outreach` route both show the same
  contact without duplicating server state, and every displayed fact has visible
  provenance (source kind, source reference, capture method, confidence, and
  user-confirmed state where applicable).
- Candidate review shows source-attempt outcomes and candidate provenance before
  confirmation; confirming a candidate creates a stored contact fact while
  preserving the research provenance.
- The **Outreach** panel shows draft gate results, claim-to-fact provenance, and
  generation history. Failed-gate drafts cannot be approved. Revising an approved
  draft creates a new candidate generation and leaves the last approved draft
  readable until a replacement is approved.
- The approved draft exposes copy/export only. There is no send button,
  transport picker, connected-account send surface, or copy action that bypasses
  the `ClipboardPort`.
- The send log is explicitly user-attested, accepts only controlled channel
  labels, and never asks for or displays a contact value as the channel. Logging
  a send is separate from approving a draft.
- Scheduling without a custom date derives the first follow-up from the
  application-submitted lifecycle; due follow-ups surface in the Follow-ups view
  as reminders only, with complete/dismiss actions that do not send or act.
- Debug/audit views, if opened during the smoke, show only ids, controlled labels,
  timestamps, lifecycle state, provenance metadata, and gate summaries for
  contact/outreach events; contact names, emails, phone numbers, notes, candidate
  values, and draft bodies stay out of event payloads and projections.

### Interview Prep Smoke

For UI/API changes around interview preparation, open a Job Detail workspace and
verify the "generate interview prep" control is enabled, confirms before
dispatching, and posts to
`POST /v1/jobs/:jobKey/actions/generate-interview-prep`. The route must return
202 when the worker is ready (503 when the worker heartbeat is missing/stale)
and must dispatch `generate_interview_prep`, not `run_stage`.

Use the E2E stub dispatcher for automation. To verify the read path, inject
accepted `job_interview_prep` / `job_interview_prep_items` rows plus an
`InterviewPrepGenerated` event into the seeded SQLite DB; then confirm the Job
Detail route workspace renders STAR drafts, gap drills labelled as gaps, evidence-map links,
requirement IDs, source snippets, gate/judge status, and accepted-residual
warnings. Confirm a failed injected generation does not hide the last accepted
prep. Record a post-interview reflection from the prep panel and confirm it posts
through `POST /v1/jobs/:jobKey/outcomes`, appears in the normal outcome timeline
with the linked prep generation, and keeps the note text out of
`job_events.payload_json`. Boundary check: no streaming input, transcript
upload, microphone, websocket, in-session state, or real-time answer surface
should appear in the UI, API routes, JSON-RPC methods, workflow inputs, or
aggregate statuses.

### Parity tests

Two parity tests are the runtime backstop to the compile-time guarantees the
type system provides; each lives next to its subject:

| Test | Location | What it asserts | Mirror |
| --- | --- | --- | --- |
| `every-event-has-handler.test.ts` | `apps/web/src/contexts/operations/` | Every `DomainEvent["eventType"]` variant has a registered handler in `invalidation-router.ts`, and the handler body is not the obvious empty stub `() => []`. | Backstop to `Record<DomainEvent["eventType"], InvalidationHandler>` — target §7.4. Mirrors the backend's `scripts/check-domain-type-parity.py` pattern. |
| `every-stage-state-has-badge.test.tsx` | `apps/web/src/contexts/pipeline/components/` | Every `STAGE_STATE_KINDS` value is rendered by a non-default `<StageBadge>` arm. | Backstop to the exhaustive `switch (state.kind)` in `<StageBadge>` — target §10.2. |

### Browser Extension QA

Manual extension QA uses a disposable workspace. Start `corepack pnpm dev`, build the
extension with `corepack pnpm extension:build`, load `dist/extension/` unpacked in
Chrome/Chromium developer mode, pair it with the Settings token, save a
synthetic posting, and confirm the job appears in Jobs and the Discovery Manual
capture tab with `manual_capture:extension` provenance. Stop the stack, save
another synthetic posting, restart the stack, save once more, and confirm the
queued capture syncs locally. Confirm Chrome reports site access for all sites,
then open a synthetic generic HTTP(S) application form on a host outside the
former Workday/Greenhouse/Lever/Ashby list. Before clicking the extension,
confirm JobCtrl has not read fields or modified the page. Click **Review
autofill**, accept selected values, and confirm the page's submit handler is not
invoked and every extension-origin HTTP request targets loopback. Do not use
real applications or submit anything from this flow.

### Accessibility bar

The Storybook `addon-a11y` is configured so that **critical** and **serious**
axe violations fail CI (`a11y: { test: "error" }`). The Storybook test runner
(`corepack pnpm web:storybook:test`) is the gate; `corepack pnpm --filter @jobctrl/web test`
also runs the colocated `*.a11y.test.tsx` suites for forms and dialogs.

The `color-contrast` axe rule is disabled in the Storybook test runner
(`.storybook/test-runner.ts`) because contrast shifts across themes, and the
jsdom `*.a11y.test.tsx` suites cannot evaluate rendered colors either. Token
contrast is therefore guarded deterministically by
`src/styles/token-contrast.test.ts`, which computes the WCAG ratio from the
resolved token values against each real surface.

No Storybook story currently defers the a11y check: no `*.stories.ts` or
`*.stories.tsx` file under `apps/web/src/` sets `a11y.test` to `"off"` or
`a11y.disable` to `true`. Any future escape-hatch use must have a matching
entry in [`docs/backlog.md`](../../backlog.md) "Frontend Accessibility Backlog" with
the story path, affected production file, and defect type.

### Storybook gate

`corepack pnpm web:storybook:build` produces the static Storybook bundle;
`corepack pnpm web:storybook:test` serves it with `http-server` and runs
`test-storybook` over every story. A story that throws on render, fails its
`play()` interaction, or surfaces a critical / serious axe violation fails
the gate.

## Materials, Direct Import And Demo Lifecycle

For achievement selection and metric ownership, exercise `/profile` with
synthetic data. The editor must show metrics as part of each achievement bullet,
not as a separate **Verified resume metrics** input. Saving a synthetic bullet
containing `£240k`, `12%`, and `£2M+` must round-trip those exact values in the
API's derived compatibility projection, while an old unrelated flat metric is
retained only as non-authoritative, unassigned legacy data. Then tailor a synthetic role
with no required bullets: the accepted artifact must never exceed the per-role
maximum, contain no uncovered filler, and preserve the exact agency
and causal meaning of every selected achievement through the final voice/judge
audit. Also configure one synthetic role whose distinct pinned plus
requirement-covered achievements exceed that maximum: Tailor must block before
any generator call, keep the durable attempt count unchanged, and report the
role, required count, and ceiling. Never run this check against a real
application or submit anything.

For candidate evaluation, use scripted generation and voice responses through
the real Materials use case. Count plan/profile-evidence construction once per
execution and provenance, grounding, fit, coverage and text assembly once per
candidate. No voice or a no-op voice reply must reuse the accepted evidence;
changed voice text must receive fresh deterministic and paid review. A rejected
rewrite retains the base text, provenance and verdict, with a separate voice
audit. Assert that the final artifact bytes come from the evaluated normalized
payload and that final fit retains its `post_voice_shipped` lifecycle label.
A fabricated high-fit candidate must make zero judge/adversarial calls. Follow
a fabricated or judge-rejected candidate with invalid JSON and prove the run
stays rejected, its history remains inspectable, and the previous accepted
artifact bytes survive. Retain the transaction and render-failure fixtures that
protect the previous accepted generation and provenance.
Include a required experience entry with no source bullets or achievement
evidence: Tailor must accept an empty bullet list while the assembled artifact
preserves its employer, title, and dates. The same empty list must fail for a
role with achievement evidence; an invented positioning bullet must still fail
its evidence check. Keep this case in the real Materials use-case fixture so
field validation, claim validation, assembly, and accepted provenance all run.
Also return parsed JSON with `skill_category_updates: null` before a valid
candidate: field validation must reject it before assembly, preserve its audit
and continue bounded repair. Exhausting that malformed response must leave the
previous accepted artifact intact. Read the rejected `.txt` for both missing
required fields and malformed nested fields: it must contain the selected JSON
and validation errors, with nonzero registered size, without invoking assembly
on invalid fields. A changed voice rewrite in lenient mode must
retain `SKIPPED` with reason `lenient_validation_mode` in both voice and final
judge metadata, without judge/adversarial calls or paid-model attribution.

For direct URL import, exercise the Jobs-page dialog through the product API
and worker boundary. A readable JSON-LD posting must create one canonical job,
refresh the list, and open that job. A custom careers page with an individual
job URL, H1, multiple job-section headings, and an embedded ATS application
form must also import without broadening generic-content acceptance. Start a
second URL import before the first resolves and prove both requests are
dispatched and can complete independently. A login/blocked fixture must create a
pending Manual Capture item, render the fallback action, and create zero jobs.
Re-importing a legacy direct-URL row whose stored Greenhouse heading is
`Job Application for <role> at <employer>` must repair the canonical role and
missing employer without refetching, duplicating the job, or duplicating its
metadata-correction event.
An active, non-quarantined import with a usable description but no separate
application URL must still persist enriched state, record Discover and Enrich
as succeeded, and start exactly one deterministic root preparation workflow
containing score, tailor, cover, and PDF—but not Apply. Retrying the import
before preparation begins must reuse that workflow ID. An incomplete legacy
import whose canonical description still matches its immutable snapshot proof
must repair its missing enrichment before the same handoff without refetching;
an already complete import also opens without refetching.
An unsafe credential-bearing, loopback, or private URL must perform no worker
dispatch, navigation, or queue write. Commit-before-ack failures after canonical
ingestion must converge on retry to one complete discovery event set and one
posting snapshot, without duplicate Jobs or events. Generic non-job articles
must route to Manual Capture instead of creating placeholder Jobs. When a
previously ambiguous URL later imports successfully, its matching pending
Manual Capture item must close against the canonical job rather than remain as
a false action item. The same product-path check must confirm employer-posted
salary evidence is projected from the imported description.

The dedicated demo-workspace Playwright lane starts Vite only; it must not
start or contact the product API or SSE endpoint. It proves same-profile tab
sharing and concurrent writes, separate-context isolation, reload persistence,
atomic reset/blob deletion, future IndexedDB-version refusal without downgrade,
one-time seed-version refresh with generated-blob cleanup,
post-commit domain-event delivery, and populated direct-refresh coverage for
the demo's dashboard, product routes, and seeded detail deep links. It also
exercises real source promotion, manual-capture import, and score correction
through the shared UI, proving that the results are reload durable and
product-network-free; score correction is also cross-tab visible. Native
browser coverage also proves that eventless Discovery and Settings writes
trigger a broad cross-tab resync and remain durable after reload. The same lane
drives deterministic queued, running, and terminal stage scenarios through
accessible product controls; covers the Contoso fail-first tailoring retry;
checks receipt history across reload and same-profile tabs; and rehearses
artifact preview, application dry-run, and mark-applied actions without an
external effect. It also proves the admitted Demo guide reaches the seeded
scoring, materials, Apply Review, and run-history shortcuts before a confirmed
workspace reset. Every scenario test installs a strict
request guard that rejects product API, SSE, and external-origin traffic. Unit
and component tests cover seed-refresh quota/memory fallback, other injected
quota/security fallbacks, schema revalidation, reset-epoch races, event-log
loss, read-adapter query/404/capability parity, valid arguments for every
browser-local command plus focused projection, replay, cascade, and
quota-rollback invariants, the reactive data-boundary warning, and the unchanged
canonical event provider/invalidation router.
Playwright artifacts are written outside the repository under the system
temporary directory.

The same lane begins with three consent regressions: no IndexedDB, health, or
product telemetry before a confirmed grant; anonymous decline redirects even
when measurement fails; and a denied revisit renders the acceptance-required
gate again. Existing product journeys use a granted same-origin API stub, so
the full suite also proves the gate does not regress admitted sessions.
