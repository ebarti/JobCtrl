# Reliability & QA

Use this page to choose the smallest QA surface that proves a change. The
complete risk matrix still exists, but the common commands and browser paths
come first.

**No single aggregate covers every layer.** Match commands to the changed
contract; do not add cross-stack checks "just in case." For an approved
unreleased stack, run focused checks per phase, finish canonical docs in the
final PR, then run product QA on the cumulative stack.

## Required Commands

| Change | Minimum starting point |
| --- | --- |
| Cross-stack behavior | `corepack pnpm check` and `corepack pnpm test` |
| TypeScript API | `corepack pnpm api:check` and `corepack pnpm api:test` |
| Web UI | `corepack pnpm web:check`, `corepack pnpm --filter @jobctrl/web test`, and `corepack pnpm web:build` |
| Frontend types | `corepack pnpm --filter @jobctrl/web test-d` |
| Browser flow | `corepack pnpm --filter @jobctrl/web e2e -- tests/<flow>.spec.ts` |
| Public demo browser workspace | `corepack pnpm --filter @jobctrl/web e2e:demo-workspace` |
| Public demo edge | `corepack pnpm demo-edge:check`, `corepack pnpm demo-edge:test`, and `corepack pnpm demo-edge:dry-run` |
| Python worker | `uv --project workers/automation run --extra dev ruff check .` and `uv --project workers/automation run --extra dev pytest -q` |
| SQLite schema or native migration | Focused Python schema/candidate tests, `corepack pnpm api:check`, `corepack pnpm api:test`, `corepack pnpm launcher:check`, and `corepack pnpm launcher:test` |
| Any patch | `git diff --check` |

Start the attached full stack with `corepack pnpm dev` when the path needs the
API, Temporal, worker, and web app together. Confirm `GET /v1/health` reports a
healthy worker before starting worker-backed stages.

For compensation changes, the Job Detail product-path check must cover both an
accepted range and an insufficient-evidence result. Verify that the posted
amount and market range (or explicit no-reliable-range outcome) are the visual
headlines; cash is not relabelled as separately mentioned equity; the inferred
level is correct; evidence/provider counts expand into the actual salary
evidence records and reported sample counts; reliability percentages explain
their basis; and the normal focused refresh has no local observation-path
input.

## Pick The Right Checklist

| You changed… | Use |
| --- | --- |
| Workflow durability, apply safety, storage, or another known high-risk invariant | [Regression Catalog](developer/qa/regression-catalog.md) |
| A page, drawer, review flow, artifact, or browser extension | [Browser Smoke](developer/qa/browser-smoke.md) |
| Tokens, shared primitives, routes, state, realtime, Storybook, or accessibility | [Frontend QA](developer/qa/frontend.md) |
| A surface with a specific historical risk or exact test mapping | [Complete Checklist](developer/qa/complete-checklist.md) |

## Temporal Fault-Injection Matrix

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
[Regression Catalog](developer/qa/regression-catalog.md#temporal-fault-injection)
or the [complete checklist](developer/qa/complete-checklist.md#temporal-fault-injection-matrix).

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
selected execution, and a missing provider total must render as unavailable
rather than a synthetic percentage:

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
[`plans/2026-08-04-pipeline-reliability-chaos.md`](plans/2026-08-04-pipeline-reliability-chaos.md).

<a id="durable-execution-recovery-demo"></a>

## High-Risk Regression Areas

The highest-risk boundaries are apply submission safety, credential/privacy
containment, workflow durability, projection correctness, schema compatibility,
and accepted-artifact preservation. The
[Regression Catalog](developer/qa/regression-catalog.md) explains which layer
proves each class of invariant; the complete page maps every risk to exact tests.

### Automatic compensation discovery and projection

Use disposable exact-schema databases only. The gate must prove that terminal
Discovery invokes the replay-patched automatic activity before terminal
preparation, while histories recorded before the patch schedule no new command.
An absent or explicitly disabled Levels.fyi preference must perform no Levels
request; an enabled preference may load it through the policy-routed client.

For benchmark state, prove a missing slice refreshes, a fresh slice skips until
the seven-day boundary, an unavailable source retries after one day, stale lease
holders cannot publish, and one broken source preserves independent evidence.
For geography, prove exact-country direct evidence stays direct, locality rows
are not promoted to country authority, and a missing country can retain a
low-confidence cost-of-living-only numeric range with direct/price/company
lineage. A raw factor outside `0.1x`–`10x` must remain visible with
`factor_out_of_bounds` in both Python and TypeScript projections. Failed refresh
must preserve the last good per-job range, and employer-posted facts must never
become direct or extrapolated market facts.

```bash
uv --project workers/automation run --extra dev pytest -q \
  workers/automation/tests/test_workflow_discovery.py \
  workers/automation/tests/test_automatic_compensation_refresh.py \
  workers/automation/tests/test_compensation_refresh_state.py \
  workers/automation/tests/test_compensation_benchmark_materialization.py \
  workers/automation/tests/test_market_compensation_repository.py \
  workers/automation/tests/test_levels_fyi_public.py
corepack pnpm --filter @jobctrl/contracts check
corepack pnpm api:check
corepack pnpm --filter @jobctrl/api exec vitest run \
  test/market-compensation-estimates.test.ts \
  test/projections.test.ts
```

### Stable JobId v7 and explicit-feedback cumulative gate

Run this gate on the final stack tip with disposable SQLite fixtures only. Do
not point it at `~/.jobctrl/jobctrl.db`, a real Temporal store, or any live
application target. The Python commands deliberately use the fixed project
virtual environment directly so validation does not rewrite lock metadata.

```bash
PYTHONPATH=workers/automation/src workers/automation/.venv/bin/pytest -q \
  workers/automation/tests/test_v6_to_v7_*.py \
  workers/automation/tests/test_exact_v7_*.py \
  workers/automation/tests/test_detail_projection_job_id_contract.py \
  workers/automation/tests/test_jobstreaming_gateway.py \
  workers/automation/tests/test_jobstreaming_resumable_discovery.py \
  workers/automation/tests/test_learning_recommendations.py \
  workers/automation/tests/test_sqlite_learning_recommendations.py \
  workers/automation/tests/test_rpc_learning_recommendations.py \
  workers/automation/tests/test_tailoring_policy_revisions.py \
  workers/automation/tests/test_scoring_eval_feedback.py
workers/automation/.venv/bin/ruff check workers/automation/src workers/automation/tests

corepack pnpm --filter @jobctrl/api exec vitest run \
  test/exact-v7-projections.test.ts \
  test/read-model-v7.test.ts \
  test/application-feedback-v7.test.ts \
  test/write-model-cancel.test.ts \
  test/server.test.ts
corepack pnpm --filter @jobctrl/web exec vitest run \
  src/contexts/operations/realtimePatches.test.ts \
  src/contexts/operations/workflowRealtimePatches.test.ts \
  src/contexts/operations/invalidation-router.test.ts \
  src/contexts/apply/components/CancelApplyButton.test.tsx \
  src/contexts/apply/hooks/useCancelApplyMutation.test.ts \
  src/contexts/materials/components/LearningRecommendationReviewPanel.test.tsx \
  src/contexts/materials/components/TailoringPolicyHistoryPanel.test.tsx
corepack pnpm web:test-d
go -C launcher test ./internal/launcher
corepack pnpm check
corepack pnpm test
corepack pnpm docs:build
git diff --check
```

The product path must then verify in a disposable seeded API/web workspace that
Runs shows the shared Discover/preparation/Apply timeline; repeated cancellation
does not overwrite a terminal result; targeted events update an open job,
registered artifact, and workflow detail without resetting filters, selection,
pagination, or scroll; and Dashboard supports recommendation evidence,
accept/reject, policy history, and explicit append-only restore. After
acceptance, explicitly re-score/re-tailor synthetic work and verify the prior
score and accepted artifact remain unchanged until those commands are invoked.
The gate must also prove that no feedback decision or restore automatically
starts scoring, tailoring, Apply, or artifact work. Do not perform a real
application submission or mutate a real user database during this QA.

The same product path must prove that a successful Enrich row can display an
explicit non-blocking application-target outcome, including LinkedIn on-site
apply, and that its technical details expose only the allow-listed outcome
rather than raw resolver metadata. The regression fixtures must cover every
application-target outcome, redact a resolver error containing a private local
path, and repair a legacy non-LinkedIn snapshot without browser navigation.
A targeted workflow run must also identify its selected stage scope in the run
heading and details.

The browser-local public demo may cover realtime state preservation, but its
learning capabilities are intentionally unavailable. Recommendation review,
policy acceptance/rejection, and rollback must therefore run through the seeded
non-demo local API/web fixture.

### Repeat-application prevention

Use disposable SQLite fixtures and the simulated web dispatch boundary; never
point this matrix at a real application target. The focused proving surface is:

```bash
uv --project workers/automation run --extra dev pytest -q \
  workers/automation/tests/test_repeat_application_prevention.py \
  workers/automation/tests/test_apply_regressions.py \
  workers/automation/tests/test_apply_saga.py \
  workers/automation/tests/test_workflow_apply.py \
  workers/automation/tests/test_rpc_handlers_apply_workflow.py
corepack pnpm --filter @jobctrl/api exec vitest run \
  test/repeat-application.test.ts \
  test/application-feedback.test.ts \
  test/schema-version-guard.test.ts
corepack pnpm --filter @jobctrl/web exec vitest run \
  src/views/apply-review/ApplyReviewView.test.tsx \
  src/contexts/apply/components/ApplyReviewDecisionControls.test.tsx \
  src/contexts/apply/hooks/useApplyReviewMutations.test.ts
corepack pnpm --filter @jobctrl/web e2e -- tests/repeat-application.spec.ts
```

The fixtures must cover same-canonical-job and accepted-duplicate identities,
alternate URLs, same-employer/equivalent-role confirmation, distinct-role and
similar-employer allowance, dry-run/failed-attempt/pending-suggestion exclusion,
direct dispatch, repeated standing polls, concurrent claims, stale approval,
one-attempt consumption, and immutable audit evidence. The browser path must
show the exact block, prior evidence, reasoned confirmation, refreshed
override-ready state, and a simulated live dispatch while proving no
`ApplicationSubmitted` fact was created.

### Pipeline history recovery and restart regression

Reproduce the human-reported partial-projection state with an active Discover
execution, 72 expected execution members, 15 persisted members, 16 expected
pipeline-step keys, four persisted keys, one live source-family activity, three
live tailoring activities, and an approximate activity backlog of 41. Verify:

- the durable checkpoint and operations response remain `recovering`; partial
  row counts, active slots, and fresh telemetry never promote it to `ready`;
- the UI renders **Restoring pipeline history**, the 15/72 and 4/16 restoration
  progress, and the live worker/queue/activity facts;
- selected-run counts, stage percentages, source/reconciliation ledgers, ETAs,
  **0%**, and **No work remaining** stay hidden until the checkpoint is `ready`;
  and
- a stale `ready` row whose exact key digest no longer matches is downgraded to
  `recovering` by the API and selected for worker repair;
- an idle snapshot with no selected execution has `projectionCoverage: null`
  only when fresh available telemetry proves zero active slots; occupied, stale,
  or unavailable runtime inventory reports `recovering` instead of fabricated
  idle or `ready`; and
- a non-ASCII membership and stage-key golden vector hashes identically in the
  Python recovery writer and TypeScript API validator.

Then exercise the write-side recovery controller with legacy queued, running,
completed, and failed activities, a mixed legacy/native history, and a true
empty native execution. Kill the worker after a partial replay while leaving
Temporal running, restart the worker, and verify that startup reconciliation:

1. resumes from the exact workflow/run history without starting, canceling, or
   signaling a discovery workflow;
2. restores source and backlog memberships, work plans, and step lifecycle
   events without duplicates;
3. records the current Temporal history-event watermark and exact membership
   and step-key digest; and
4. publishes `ready` only after projection refresh and exact set equality.

For native streaming history, verify that the producer-lifetime live enrichment
activity remains runtime-only and is excluded from the durable expected-step
set, while terminal enrichment reconciliation remains required. A closed run
must not retry forever because `streaming:live` intentionally has no persisted
`PipelineStep*` lifecycle.

The legacy fixture must also reproduce the lossy projection shape: repeated
fanout passes declare `0`, `71`, `67`, and `34` targets with legitimate overlap,
the folded workflow projection retains only `jobUrl`, and the append-only event
log retains both causal job-only starts and exact full summaries. Verify decoder
v2 derives the 72-member union from each fanout's exact interval, rejects a
per-pass target-count or workflow-run mismatch, restores all 16 declared stage
keys, persists `legacy_history_recovery` as a valid bounded reason code, and
reaches a verified 72/72-membership and 16/16-step `ready` checkpoint.

For ambiguous mapping or a transient history read, verify `retrying` with a
bounded error code, automatic heartbeat retry, and no mutation of the running
workflow. Run the focused worker reconciliation tests, API checkpoint tests,
Pipelines component tests, and the live browser path together. The live pass
must compare the operations response with the rendered workspace so shared-pool
telemetry cannot be mistaken for selected-run proof.

When source-family provider traversal is present, expand **Crawl sources** at a
desktop viewport and assert that its traversal evidence and exact-outcomes
ledger have disjoint layout rectangles. Repeat below the responsive breakpoint
and assert that traversal finishes above the outcomes ledger. This is the
regression guard for multiple evidence blocks sharing one stage detail row.

Also cover the retry and terminal edge cases. A successful fanout retry with
`attempt > 1` must restore exact membership and steps without inventing a queue
timestamp. A failed attempt that is waiting to retry, or a later attempt that is
still running, must remain non-terminal and cannot publish `ready` or a false
failed step. A canceled or terminally failed fanout with no retry remaining must
preserve its exact partial membership, work plan, failed-step evidence, digest,
and watermark as `projectionCoverage.status = incomplete`. Its expected counts
remain unknown in the API and UI. Restart the worker and verify that the closed
incomplete run is not selected for automatic repair again. Pipelines must label
the history as incomplete, avoid claims about the missing remainder, and expose
**Set up a new Discover run** only when active work is exactly zero.

Finally, begin from a valid `ready` manifest and force a transient history-read
failure. Verify the worker first demotes it to `retrying`, preserves the prior
proof for audit, and returns to `ready` after the authoritative history becomes
readable; it must not leave stale ready data published during the failure.

### Public demo privacy and edge gate

When consent, cookies, telemetry, D1, retention, or Cloudflare configuration
changes, the edge suite must prove that decline creates no analytics identity,
grant is required before telemetry, cookie attributes and versioning remain
exact, event fields stay allowlisted, retries do not double-count, rate limits
fail closed, and expired identities/events/counters are deleted. Before public
cutover, also repeat the consent and retention paths through local Wrangler and
the production-mode browser lane. Verify direct SPA deep links, Pages security
headers, the same-origin `/api/*` route, D1 migration state, and one Pages
rollback before calling the public deployment healthy.

### Provider setup gate

When provider auth, Settings credentials, model routing, or employer analysis
changes, prove each sanctioned provider independently: Codex persisted CLI auth,
Claude API/cloud auth, Google Gemini key, Google standard ADC, and an existing
regular `GOOGLE_APPLICATION_CREDENTIALS` service-account file. Project metadata,
missing credential files, consumer Claude OAuth, raw OpenAI keys, and deferred
local/custom endpoints must not unlock readiness. Inject a failure at every
Keychain batch boundary and prove exact rollback, then exercise provider-level
revocation, the three-card Settings route at desktop/mobile width, the demo
read-only boundary, and a sole-provider draft plus synthesis path without making
a live model call. For model selection, use deterministic SDK fakes to prove
catalog order, ready-only listing, Codex hidden/invalid filtering, Google
generate-content filtering, Claude runtime-catalog normalization, stable deduplication, and
sanitized failures. Prove settings reject an unready provider or unoffered ID,
allow a clear while unready, persist no credential data, and exercise precedence
for explicit workflow, selected-provider preference, and provider default
without executing a live provider request. When an active provider route is
environment-owned, prove its secret and removal controls stay read-only while
another supported route remains editable. Saving that alternative must not
displace the active environment route before the environment value is removed
and the relevant process restarts.

### Browser capability adoption gate

When browser detection, adoption, profile copying, or Settings browser UI
changes, prove that listing capabilities only performs passive detection and
returns opaque browser kinds plus labels—never executable paths. Listing must
not launch, adopt, or persist a browser. Enabling requires an explicit detected
selection or one advanced manual path, re-resolves a detected selection at
mutation time, and fails closed when the installation disappeared. Profile-copy
consent remains a separate affirmative action; capability enablement must not
imply it. With Default plus at least one `Profile N` fixture, prove Settings
renders every safe Chrome display label, forwards the chosen opaque profile ID,
copies only that profile as the isolated owned Default, and never returns a host
path. Replacing a prior consented copy must stage the new profile first, preserve
the old copy on pre-publish or post-publish state-validation failure, and exclude
every sibling profile. Concurrent replacements must serialize through publish,
state validation, rollback, and cleanup so a stale failure cannot overwrite a
newer successful selection.

For Chrome records whose `is_using_default_name` flag is true, use the bounded
`gaia_name` as the recognizable label instead of Chrome's generic default such
as `Your Chrome`. A custom profile `name` must continue to win when that flag is
false, and neither case may return the account `user_name` (email), directory
name, or host path.

<a id="scoring-policy-eval-gate"></a>
<a id="saved-views-smoke"></a>
<a id="daily-digest-smoke"></a>
<a id="resume-tailoring-quality-eval-gate"></a>

## Frontend QA

Frontend verification has four distinct jobs: logic/type correctness,
component accessibility, route-level browser behavior, and visual consistency.
The [Frontend QA guide](developer/qa/frontend.md) gives the commands and the
[Browser Smoke guide](developer/qa/browser-smoke.md) gives the user paths.

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

<a id="token-foundation-qa-gate"></a>
<a id="shared-primitive-qa-gate"></a>
<a id="route-visual-qa-gate"></a>
<a id="coverage-layout"></a>
<a id="scoring-policy-feedback-smoke"></a>
<a id="jobs-drawer-audit-smoke"></a>
<a id="evidence-map-smoke"></a>
<a id="apply-review-smoke"></a>
<a id="materials-generation-inspector-smoke"></a>
<a id="outreach-draft-review-smoke"></a>
<a id="outreach-planner-product-smoke"></a>
<a id="interview-prep-smoke"></a>
<a id="parity-tests"></a>
<a id="browser-extension-qa"></a>
<a id="accessibility-bar"></a>
<a id="storybook-gate"></a>

## Cumulative Rhea/Base UI Final Gate

Run this gate after the cumulative redesign branch has its canonical docs and
synthetic fixtures. It complements focused phase checks; it is not a substitute
for the security, apply, or workflow matrices above.

```bash
corepack pnpm --filter @jobctrl/web exec vitest run \
  src/styles/token-contract.test.ts \
  src/styles/token-contrast.test.ts \
  src/styles/shared-layout-contract.test.ts \
  src/styles/profile-evidence-responsive-layout.test.ts \
  src/styles/apply-review-contacts-responsive.test.ts \
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
JOBCTRL_E2E_APP_DIR=/tmp/jobctrl-route-qa \
JOBCTRL_E2E_API_PORT=8878 \
JOBCTRL_E2E_WEB_PORT=5275 \
corepack pnpm --filter @jobctrl/web e2e -- tests/route-visual-qa.spec.ts
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
  IDs fail closed, manual path entry remains an advanced explicit fallback, and
  profile copying still requires separate consent;
- an environment-owned active provider route stays authoritative and read-only
  while alternative supported routes remain editable but inactive; and
- a retry with `runAfter: true` preflights worker readiness before resetting
  the failed stage. If the worker is unavailable, the API returns the readiness
  failure and preserves the stage state, attempt count, diagnostics, and audit
  evidence unchanged.

## Safe QA Data

Use synthetic or disposable workspaces for destructive, browser, extension,
mailbox, materials, and workflow QA. Do not run application submission, scan a
real mailbox, spend against a live model, or mutate a real profile/database just
to verify a change.

```bash
corepack pnpm qa:seed /tmp/jobctrl-qa
JOBCTRL_DIR=/tmp/jobctrl-qa corepack pnpm api:dev
VITE_JOBCTRL_API_BASE_URL=http://127.0.0.1:8766 corepack pnpm web:dev -- --port 5173
```
