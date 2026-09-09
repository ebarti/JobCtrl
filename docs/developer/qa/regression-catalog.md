# Regression Catalog

Use this page when a change touches a product invariant with costly failure.
Choose the risk family first; the
[complete checklist](complete-checklist.md#high-risk-regression-areas) maps each
individual regression to exact test files.

## Risk Families

| Boundary | What must remain true | Proof shape |
| --- | --- | --- |
| Apply safety | Model-driven browsers never own final submit and direct use-case/saga/adapter calls fail closed; their prompt contains no profile, job-description, resume, cover-letter, generated prose, or local artifact paths; reviewed materials are not staged in the agent worker; artifact upload, generic form entry, credentials, and verification-code tools are explicitly denied and absent from the default MCP configuration; no owned email send occurs without exact approval; every Apply page/request stays on the reviewed canonical origin; dry-run grants only one exact reviewed initial navigation, records it, and cannot write; only one exact dedicated terminal result record affects state, and a model-only dry-run claim remains partial evidence; owned submit intent is at most once; confirmed prior applications block or require an evidence-bound one-attempt confirmation. | Apply use-case/saga/adapter tests plus a disposable browser harness. |
| Durable workflows | Accepted work resumes or terminalizes correctly across restart, cancellation, and history loss. | Workflow tests plus targeted fault injection. |
| Storage and projections | Schema versions are guarded; canonical writes and read projections agree; accepted artifacts survive retries, including failed cover-letter refreshes whose rejected bytes remain on separate audit paths. | Repository/projection tests and API readback. |
| Credentials and privacy | Secrets, profile content, raw mail, contact values, paths, and artifacts do not leak into settings, events, logs, or projections. | Boundary tests plus response/event inspection. |
| Scoring and materials | Evidence, policy version, provenance, judge output, and fabrication gates remain inspectable and honest; free-form review/prior-output text remains audit-only while retries use bounded code-owned guidance. Cover generation never treats job-post numbers/dates as candidate evidence and retries them with qualitative, code-owned guidance. | Deterministic fixtures, quality evals, retry prompt-boundary regressions, and inspector smoke. |
| Frontend state | URL/server/client state stay in their owning layers; every event and stage state has a handler/rendering path. | Hook/component/type tests plus parity tests. |
| Rhea/Base UI system | Tokens, cards, statuses, accessible primitive behavior, and route parity remain coherent across theme, density, and viewport. | Token/boundary tests, focused wrapper tests, route visual QA, and the browser matrix. |
| Pipeline operations | Execution topology, privacy, refresh behavior, ETA, freshness, queue, and capacity remain truthful and separately inspectable. | API/read-model tests, deterministic fixtures, invalidation/polling tests, and browser observation. |
| Provider/browser setup | Environment ownership and passive detection cannot silently become credential or browser adoption. Extension pairing-token presence remains distinct from one explicitly selected installation's fresh live heartbeat; another Chrome profile with the token cannot lease. Integrated Discovery uses only that installed extension in the user's current Chrome profile, with no copied-profile or direct-network fallback and no browser-owned cookie/user-agent headers in worker tasks. Hanging/canceled tasks close their tabs, active leases remain live past 45 seconds, four-way admission uses backpressure, cross-origin redirects are blocked before dispatch, and UTF-8 byte bounds stop streaming early. | Worker/API bridge tests, two-installation contention and lease-liveness tests, extension persistent-context timeout/redirect E2E, Settings/Pipelines components, and a bounded live Discovery smoke. |
| Retry preflight | Starting a retry cannot erase failure evidence before worker readiness is known. | API state-before/state-after regression plus route smoke. |

## Temporal Fault Injection

For the affected workflow, prove four outcomes:

1. Kill the worker mid-activity: the same workflow resumes from durable history
   or reaches its designed verification state.
2. Cancel the run: cancellation propagates, the requester/source is auditable,
   and the read model eventually shows a terminal state without deleting
   completed facts. For batch Enrich, every unfinished selected row is
   `canceled`, unrelated pending rows stay pending, and a restarted reconciler
   reaches the same result from persisted ownership.
3. Make Temporal unavailable at start: the caller receives a clear error and no
   in-process fallback runs.
4. Lose local dev-server history: the reconciler terminalizes orphaned open rows.

An Enrich restart also proves the API-to-worker ownership handoff: canonical
`job_enrichments` state, not stale projected text, selects the reset row; a
repeat pickup cannot bypass queued/running Enrich; and queued metadata carries
the exact Temporal execution ID (`firstExecutionRunId`). A workflow handle is
never accepted as an execution owner. Matching and foreign-owner worker probes
must respectively process and reject the same prequeued fixture.

Timeout and explicit cancellation are separate fault classes. A timeout,
worker shutdown, or reset releases unfinished Enrich ownership for the same
Temporal execution to retry; only an explicit cancellation request
terminalizes the exact owned cohort. The successful canonical Enrich IDs, not
the original selection, become the Score/Tailor/Cover subset. For authenticated
LinkedIn recovery, ordinary extraction attempts do not consume the independent
three-pass apply-URL budget, and browser extension requests remain blocked
without being misreported as an unsafe posting redirect.

Selected Tailor and Cover batches must use their requested bounded worker count.
A durable item failure yields a partial batch with inspectable item diagnostics;
it does not retry approved jobs or prevent Cover from running for the exact
approved Tailor subset. Their selected-batch activity deadline scales at 30
minutes per worker wave, capped at 6 hours and protected by a Temporal patch
marker so replay of older open histories retains its recorded 30-minute timer.
The heartbeat timeout remains 2 minutes. Concurrent job-specific prompt
snapshots must retain distinct artifact fingerprints while reusing one global
policy revision when the complete tailoring-relevant profile projection,
profile/custom controls, learned rules, prompt/schema versions, models, judge
settings, and validation mode are identical. A tailoring-relevant profile or
control change advances the global revision and rejects stale artifact
persistence; an application-only compensation/authorization/defaults edit does
not. The canonical projection/policy comparison and artifact save share one
SQLite write transaction. The artifact audit digest
must match the exact role/content messages for the selected candidate, including
target-job and retry content. Canceling a real selected Tailor or Cover batch
after its first worker wave starts must prevent later waves, fence every
in-flight write, cancel only unfinished rows still owned by that execution, and
preserve both successor-owned rows and artifacts committed before cancellation.
If a blocking runner ignores the cooperative cancel token, the worker must
record `abandoned_thread`, retire that blocking-executor generation, and prove a
subsequent activity can execute immediately on fresh bounded capacity. The
abandoned generation must be distinct from Temporal's synchronous-activity
executor so capacity recovery cannot break marker or reconciliation activities.
Tailor's inner candidate-repair attempts are audit metadata, not the durable
stage retry counter. Each durable activity execution increments that outer
counter exactly once; repeated failures reach non-retryable `exhausted` at the
configured maximum and are excluded from automatic pickup until an explicit
attempt reset. Repeated durable executions of one materials generation must
append audit entries keyed by execution and durable attempt rather than replace
the prior prompt/candidate/validator/judge record.

The Score-to-Tailor evidence handoff is one generation-bound contract. Change a
posting after an earlier employer analysis, then prove Score refreshes through
the analysis cache owner and writes fit evidence for the refreshed generation.
Tailor must never turn a missing or mismatched fit report into a zero-edge plan:
it blocks on Score without spending a durable attempt. The claim-mapping fixture
also covers explicit ordered summary-sentence identity and reconstruction,
sentence-level aliases, exact rendered bullet and skill-group text, mandatory
coverage-edge evidence, missing or duplicate generated surfaces, and immutable
raw audit payloads before any judge call.

Tailoring selection and metric ownership are also one contract. With no
required bullets and a maximum of ten bullets per role, prove the maximum stays
a ceiling: the graph retains only the strongest achievement for each target
requirement, uncovered optional inventory is omitted, and no positioning filler
is added beside covered or pinned evidence. Each emitted experience bullet must
cite exactly one achievement and may use only numbers extracted from that same
achievement, including standalone numeric claims. Profile `GET`/`PATCH` must
lead the legacy flat metric projection with bullet/evidence-derived values,
preserve unmatched old values as non-authoritative and unassigned, and expose
no separate metric editor in the Profile UI. A synthetic voice fixture must
prove a clean, precise achievement cannot be rewritten merely for verb variety; any accepted
voiced line must pass the final mapping, quality, provenance, fabrication, and
judge gates.

The [complete matrix](complete-checklist.md#temporal-fault-injection-matrix)
lists the exact tests for Discover, Pipeline, Preparation, Apply, Profile Import,
Compensation Refresh, and Interview Prep workflows.

For JobStreaming broad-board discovery, killing the activity is not enough: the
fault must land after JobCtrl commits an accepted posting and unit receipt but
before provider acknowledgement. A fresh worker must reclaim the same immutable
query/location/board unit, replay without a second job/event/count, preserve the
run-wide result limit, and expose the recovered-unit count. Cursor reset must
wait for the error acknowledgement revision; a stale activity owner must lose
its write fence; request/cursor-schema incompatibility must fail explicitly;
and cancellation must terminalize unfinished units. The hermetic proof is
`workers/automation/tests/test_jobstreaming_resumable_discovery.py`, backed by
`test_discovery_search_units.py` and `test_jobstreaming_gateway.py`.

## Durable-Execution Recovery Demo

`scripts/reliability-demo.sh` runs an isolated, no-crawl, no-LLM, no-browser
worker-kill demonstration. It verifies that the same diagnostic run IDs remain
running while the worker is down and complete exactly once after restart.

```bash
scripts/reliability-demo.sh
scripts/reliability-demo.sh 5
scripts/reliability-demo.sh 3 40
```

The script uses a throwaway `JOBCTRL_DIR` and isolated ports. Do not adapt it to
run against `~/.jobctrl`.

## Auditability Checks

When the human flags a visible defect, especially in review, rationale, audit, evidence, scoring, tailoring, or apply-approval surfaces, treat the screenshot as a symptom, not the bug. Do not start by hiding, filtering, renaming, or moving the displayed value. First state the product invariant the surface is supposed to prove, then trace the value end to end: source input, extraction, profile evidence, selected controls, prompt or deterministic transform, generated artifact, validator/judge output, persistence, projection/API read model, and UI rendering.

For auditability features, every displayed claim must have an explicit source of truth. Before editing code, identify whether the source is canonical user profile data, the job post, score evidence, tailoring policy, generated artifact text/PDF, validator output, judge/adversarial response, event log, projection row, or derived read-model computation. If the correct source is missing, compute or persist the missing audit data at the owning layer; do not remove the UI field just because the current data is embarrassing.

Any fix to evidence, rationale, keywords, persona judgments, or generated-material status must preserve user value:

- Missing/covered keyword lists are useful only when computed against the actual generated resume text or explicitly recorded generation-time coverage. Never infer misses from job keywords alone, and never suppress the missing list as a substitute for computing it correctly.
- Persona/judge summaries are not enough. If a persona score or pass/fail is shown, the audit trail must make the prompt, rubric, model response, score basis, blockers, warnings, and repair instructions inspectable when the data exists.
- Post-generation warnings must be labeled by lifecycle: whether they were used to repair a candidate, accepted as residual warnings on the selected candidate, or produced after acceptance and therefore did not influence the artifact.
- Re-tailor/retry actions must not hide or suppress the last accepted artifact until a replacement is approved. Failed refreshes remain audit history; they must not destroy the current reviewable material.

Before claiming "fixed" on these surfaces, add or update a regression fixture that proves the exact invariant the human complained about. Prefer a fixture that reproduces the bad state from canonical data rather than a shallow component snapshot. State what was verified and what was not; do not use "fixed" for cosmetic masking.

## Cumulative Redesign Boundaries

The `base-rhea` preset, semantic tokens, Geist type, 10px radius scale,
capped 24px cards, neutral chart ramp, violet focus/primary treatment, and
icon/dot-plus-text domain statuses form one contract. Direct Radix imports, raw
native selects, route-local primitive replicas, capsule statuses, and
card-per-datum layouts are regressions even when the page compiles. Body copy is
16px in every density; density changes geometry only. Primary routes share the
compact PageHead hierarchy. Prove the same production-shaped content across
light/dark, all three densities, desktop, collapsed rail, and 390×844.

Jobs has three user queues—Active, Deleted, and Hidden—even though `closed`
remains a compatible URL/read-model value for old links. Active rows omit
redundant posting-lifecycle copy, Sources and Warnings are hidden only in the
default presentation, destructive actions retain destructive treatment, and
focus-only row activation remains keyboard discoverable. At 900px and below,
Jobs, Artifacts, Contacts, Discovery, and Settings record tables must keep their
fields and sort/filter access in labelled cards instead of overflowing the
page. Profile and Evidence Map must stack their desktop regions. Apply Review
keeps the queue left on working desktops, then stacks it above sequential
full-width content and wraps decisions as space narrows. Artifact Detail keeps
the document preview after the audit details.

Pipeline operations uses a deterministic execution with three source families
and exactly two reconciliation steps. Current execution, execution sweep, and
global backlog remain distinct; raw activity inputs and private identifiers
must not enter the read model or DOM. Verify event invalidation, bounded polling,
ETA/freshness/capacity/task-queue degraded states, observation time, and active
inventory without replacing unavailable evidence with a numeric guess. Exact
stage outcomes must remain available even when the primary view summarizes them
as running, waiting, finished, and attention totals. The UI must use **N of M
finished**, never **N% terminal**, and must keep source-family counts visibly
separate from worker and browser capacity. A genuine coverage rebuild must say
**Checking previous run records**, explain that it finishes automatically, and
must not present the internal recovery state as ongoing work. Stopping active
discovery must refresh the pipeline snapshot. Replacement-run setup is allowed
only for an exact zero active-work inventory, never for a positive or unavailable
inventory, and it must not dispatch until the user submits the Discover controls.

Browser reads may detect installations only to return opaque kinds and labels.
They must not disclose paths, launch, adopt, or persist a browser. Enablement is
explicit, re-resolves the selection, and fails closed when stale; manual path
entry and profile-copy consent remain separate. An environment-owned provider
route stays active and read-only while alternative routes remain editable but
inactive until environment removal plus restart.

For retry with `runAfter: true`, worker readiness precedes reset. A readiness
failure leaves state, attempts, error details, retryability, and audit evidence
unchanged and dispatches no work.

## Live Profile Discovery And Automatic Recovery

healthy worker before starting worker-backed stages.

For the live-profile Discovery gate, start from a built and reloaded unpacked
extension. With the API running but the extension stopped or carrying an old
token, prove the Browser settings surface says offline and a Discover launch is
rejected before Temporal dispatch. Also prove job-level and bulk Enrich
runs/retries reject before dispatch, and that every retry rejects before its
stage state, attempt count, diagnostics, metadata, or event history are reset.
Pair/reload the extension, wait for
`GET /v1/discovery/browser-extension/status` to report a fresh versioned
heartbeat, and prove Pipelines enables Discover. The extension E2E must lease a
synthetic public-looking API task whose origin root is non-HTML, execute it in
the extension service worker from the same persistent Chrome context where a
site cookie was set, return that cookie-observed response, and leave no copied
profile or API tab. Reproduce a request that never responds and prove the hard
task timeout posts a retryable failure without leaving a tab. Reproduce a
public-to-loopback redirect in both HTTP and rendered-page modes and prove the
loopback target receives no request. The rendered-page result must be promptly
non-retryable `unsafe_redirect`, without consuming the task timeout. Render a
fixture that hydrates its posting through a second origin and prove its
page-owned fetch succeeds. Return a retryable task failure for one job/target
and prove remaining Enrich, ATS, and Smart Extract targets complete in the same
attempt; preserve the failed target's retryability. Extension unavailability and
cancellation must still abort the attempt.
Also lease a rendered-page task against a delayed LinkedIn SDUI fixture:
`JobDetails_AboutTheJob_*` must remain unready while empty, then return its
populated description even when cold hydration takes longer than 12 seconds.
Preserve that section through snapshot cleaning and deterministic extraction,
excluding neighboring company and recommendation content. Background-tab polling uses a monotonic deadline, not
a count of requested sleep intervals; a never-ready page fails and cleans up.
Finish source intake while a live Enrich capture is in flight and prove the
terminal pass reclaims and processes its job instead of leaving it canceled.
Separately cancel the owning workflow and prove its exact cohort still closes,
including queued rows released by the stopping consumer.
Pair two installation IDs and prove only the explicitly
selected one can heartbeat/lease/complete; token rotation must clear that
binding. Admit four concurrent leases, reject a fifth with bounded backpressure,
and prove the worker waits for capacity before starting its lease deadline.
Keep an active lease alive beyond 45 seconds and prove Settings remains
connected. Feed multibyte request/result fixtures and an oversized stream to
prove byte bounds and early cancellation. Worker fixtures must prove every
JobStreaming adapter session plus ATS, Workday, Smart Extract, robots, and
integrated detail enrichment select the live bridge under an exact
`DiscoveryExecutionRef`; browser-owned Cookie/User-Agent headers must never
cross the worker task. Seed an unresolved legacy WelcomeToTheJungle row and
invoke the outer Temporal `run_enrichment()` entry: workflow/run identity must
be bound before legacy URL repair, and neither Playwright nor direct networking
may run. Reproduce a LinkedIn detail request whose anonymous
`robots.txt` policy denies the crawler and prove the owner-authenticated live
Chrome session still performs the bounded exact-origin fetch through the
extension while pacing, request budgets, URL safety, and audit history remain
active. Prove that a Temporal-backed standalone Enrich retry synthesizes its
bridge execution reference, never launches or reads a copied profile, and that
extension reconnection recovers both the current blocked-condition value and
the legacy value without duplicate dispatch. Finally, run a bounded Discover
product path and confirm the bridge reports task activity and the workflow
reaches a truthful terminal or actionable failed state. Do not use an
application form and do not submit anything.

For automatic preparation recovery, seed canonical failed enrichment and a
saved enriched/unscored job, then exercise worker startup/heartbeat without a
Discover command. Prove enrichment can advance to a persisted score, a restart
or lost dispatch acknowledgement retains one execution, and retries preserve
attempts and cooldowns. Include canceled/unsafe/blocked/exhausted, deleted,
closed, and other-tenant jobs; preserve accepted scores/materials and prove no
Apply dispatch. The historical discovery consumer-stop fixture must require
positive evidence from the exact completed run and reject user cancellations.
Use the real Temporal recovery fixture to prove worker replacement, late
provider results after cancellation, and exact stopped-owner settlement.
Missing workflow history must retain ownership; a recovered enrichment lease
must reject a late predecessor write.
For an automatic batch interrupted by an activity timeout, include one consumed
job and one reservation that never started. Prove the latter returns to pending
with unchanged attempt counters and can enter a new workflow after cooldown,
including when the earlier cleanup already marked it `PREPARATION_RECOVERY_STOPPED`.
Require the exact execution's timeout and durable attempt progress; cancellation,
termination, missing history, mismatched cohorts, and preflight-only failures
must not release reservations. Include copied timeout history in a reset
descendant and a mismatched scheduled activity owner. Recheck protected rows
while holding the write lock.
An owned Score must persist a requirement-fit report for its exact score version,
and real Tailor prerequisite evaluation must consume it. Reproduce a historical
missing report, rescore only that job through the normal workflow, preserve the
old score, and prove both explicit and automatic Tailor continuation. Automatic
continuation must respect the real cooldown. Incoherent or empty reports and
canceled, exhausted, non-retryable, or budget-exhausted rows must remain blocked
from automatic resumption.
Dashboard source-health and digest QA must show JobStreaming names while
retaining the underlying quarantine, failure counts, and stable source IDs.
For fetch-condition recovery, seed the exact legacy `DETAIL_UNSAFE_URL` DNS
failure and a typed equivalent with matching canonical attempts/events. Prove
both posting and failed-request destinations must pass fresh public checks,
normal worker dispatch preserves attempts/cooldown, and private, canceled,
changed-owner, deleted, closed, exhausted, and unrelated rows remain untouched.
Check the five-recheck cap, immutable failure history, and API/worker projection
parity. Exercise DNS rebinding and private redirects through the real guard,
and confirm a later timeout cannot replace stronger destination-denial evidence.
The job drawer must show the typed cause, historical observation, current
recheck result, and manual fallback without claiming the original denial was a
permanent site policy or suppressing technical evidence.
For summary metric grounding, seed a baseline tenure estimate with no supporting
achievement and a separately pinned verified metric. The normal Tailor use case
must reject the tenure claim even with an unrelated citation, retain that failure
in the audit, accept a grounded qualitative rewrite, and preserve the pinned
metric and original profile. Retry instructions remain code-owned guidance.

## High-Risk Regression Areas

The highest-risk boundaries are apply submission safety, credential/privacy
containment, workflow durability, projection correctness, schema compatibility,
and accepted-artifact preservation. The
[Regression Catalog](regression-catalog.md) explains which layer
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
- the UI renders **Checking previous run records**, the 15/72 linked-job and
  4/16 stage-record check progress, and the live worker/queue/activity facts;
- selected-run counts, source/reconciliation ledgers, ETAs, **0% terminal**,
  and **No work remaining** stay hidden until the checkpoint is `ready`;
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

For the isolated Codex SDK environment, merge hostile ambient credential and
auth-endpoint overrides as the real SDK does. Credential values must remain
cleared, while refresh/revocation requests must build valid HTTPS URLs for
OpenAI's default endpoints. Empty URLs must not mask an expired or rejected
saved login as a request-builder failure.

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

When browser detection, adoption, legacy profile-copy compatibility, or
Settings browser UI
changes, prove that listing capabilities only performs passive detection and
returns opaque browser kinds plus labels—never executable paths. Listing must
not launch, adopt, or persist a browser. Enabling requires an explicit detected
selection or one advanced manual path, re-resolves a detected selection at
mutation time, and fails closed when the installation disappeared. Profile-copy
consent remains a separate affirmative action on the backward-compatible API;
capability enablement must not imply it. Settings must not expose the legacy
`authenticated-linkedin-browser` capability or any profile-copy action, because
integrated Discovery and Enrich use the paired live-profile extension. With
Default plus at least one `Profile N` fixture, prove the legacy API forwards the
chosen opaque profile ID, copies only that profile as the isolated owned
Default, and never returns a host path. Replacing a prior consented copy must
stage the new profile first, preserve the old copy on pre-publish or
post-publish state-validation failure, and exclude every sibling profile.
Concurrent replacements must serialize through publish, state validation,
rollback, and cleanup so a stale failure cannot overwrite a newer successful
selection.

For Chrome records whose `is_using_default_name` flag is true, use the bounded
`gaia_name` as the recognizable label instead of Chrome's generic default such
as `Your Chrome`. A custom profile `name` must continue to win when that flag is
false, and neither case may return the account `user_name` (email), directory
name, or host path.

<a id="scoring-policy-eval-gate"></a>
<a id="saved-views-smoke"></a>
<a id="daily-digest-smoke"></a>
<a id="resume-tailoring-quality-eval-gate"></a>
