# Pipeline Reliability Chaos Campaign

- **Status:** R01-R26 completed, including live read-model reconciliation
- **Authored:** 2026-08-04
- **Environment:** Production-shaped local stack with disposable non-production data
- **Safety boundary:** Never use `~/.jobctrl/jobctrl.db`, real applications, or real submission targets

## Reliability Contract

Reliability remains simple when ownership is explicit:

1. Durable state identifies the workflow/activity that owns every `running` item.
2. Losing that owner produces one idempotent recovery decision that must succeed before the owning workflow can terminalize.
3. Recovery resumes at the earliest incomplete stage and reuses valid upstream work.
4. Accepted scores and artifacts remain available until a replacement succeeds.
5. Runtime inventory and durable stage state converge; zero live work cannot coexist indefinitely with `running` rows.
6. Canceling a batch records who requested it and terminalizes every unfinished
   member of its exact selected cohort without mutating unrelated pending work.
7. Inner model-repair attempts and durable stage executions have separate,
   bounded counters; retrying a failed stage must converge to `exhausted`.
8. A workflow's terminal policy exclusion must be persisted as an explicit,
   reversible `skipped` stage decision; it cannot remain ownerless `pending`.

Every scenario below must prove those eight invariants through the database,
Temporal history, API operations snapshot, and rendered Pipelines UI. A
scenario fails if it needs a manual retry button unless the terminal condition
is explicitly non-retryable.

## Test Topology

The campaign owns an isolated `JOBCTRL_DIR`, SQLite database, Temporal data directory, task queue, API port, web port, and process manifest. It seeds synthetic jobs spanning pending, blocked, running, succeeded, and accepted-artifact states. Fault injection may kill only PIDs recorded in that manifest. Provider, browser, LLM, and renderer behavior is deterministic unless a scenario explicitly enables one real local capability.

## Scenario Matrix

| ID | Starting state | Injected condition or fault | Required result |
| --- | --- | --- | --- |
| R01 | Pending enriched jobs, healthy stack | Start preparation | Score, tailor, cover, and PDF drain; durable and runtime counts converge. |
| R02 | Browser capability unavailable | Run discovery containing LinkedIn plus another source | LinkedIn enrichment blocks on the exact browser condition; unrelated work continues. |
| R03 | R02 blocked rows | Make the authenticated browser ready | Only condition-matching rows resume; Discover does not rerun and valid scores are not recomputed. |
| R04 | Any recovery workflow already queued/running | Repeat the setting mutation and recovery request | One deterministic recovery execution; no duplicate events, artifacts, or spend. |
| R05 | Discovery source activity running | Kill the worker process tree, then restart it | The same Temporal execution resumes from its durable checkpoint and completes once. |
| R06 | Enrichment activity running | Kill the worker process tree, then restart it | The exact activity is redelivered; stale owners lose write authority; no duplicate accepted posting. |
| R07 | Batch and per-job scoring running | Kill the worker before and after a score commit | Committed scores are reused; uncommitted work retries; no orphaned `running` score rows. |
| R08 | Tailoring or cover generation running with an accepted prior artifact | Kill the worker during generation and validation | The prior accepted artifact remains; the incomplete generation retries or terminalizes honestly. |
| R09 | PDF rendering running with accepted source text | Kill the worker/render subprocess | Text artifact remains; rendering resumes without regenerating approved text. |
| R10 | Activity retries exhausted while no worker is available | Start a healthy worker later | The workflow keeps one durable owner reconciliation pending; the healthy worker completes it without user action. |
| R11 | API receives a setting change that can unblock work | Kill API after commit and before workflow dispatch | Restart observes the durable change and performs the missed idempotent dispatch. |
| R12 | Workflow and activity in flight | Stop and restart Temporal | The run resumes from persisted history, or history loss terminalizes it honestly and clears owned stage rows. |
| R13 | Healthy stage activity | Make Temporal unavailable before dispatch | Caller gets a clear start failure; no synchronous fallback or stage-state mutation occurs. |
| R14 | Active SSE/UI session | Restart API and disconnect/reconnect web transport | UI becomes fresh without a toast storm, duplicate action, or stale active count. |
| R15 | Profile, preferences, and browser settings mutate concurrently | Apply each change twice in varied order | Only affected stages/jobs resume; compensation changes never rescore or block tailoring. |
| R16 | Spendful stage running | Inject timeout, rate limit, malformed model output, and exhausted budget | Retries are bounded; retryable versus terminal state is accurate; no infinite workflow. |
| R17 | Browser/profile-copy operation pending | Fail copy, then repair it | Capability stays unavailable until copy readiness is real; exact blocked work resumes once. |
| R18 | Renderer/browser executable unavailable | Restore the executable after a terminal or blocked attempt | The owning condition clears and pending render/enrichment resumes without upstream recomputation. |
| R19 | Stage-state transaction in progress | Hold a SQLite lock and kill the writer at selected commit boundaries | Transaction rolls back or commits atomically; projections reconcile without split-brain state. |
| R20 | Existing listener, stale heartbeat rows, or orphan child process | Start the supervisor again | Health identifies the actual listener/poller; the supervisor replaces or reports the conflict rather than duplicating processes. |
| R21 | Queued and in-flight work | Restart Temporal, worker, API, and web in varied orders | Every order converges to the same durable result with no manual recovery. |
| R22 | Mixed jobs with valid scores, missing scores, and pending materials | Trigger profile/preference continuation | Valid scores are reused, only missing/stale scores run, and downstream work begins as soon as each job is ready. |
| R23 | Global or explicitly selected Enrich cohort running | Request cancellation through JobCtrl or Temporal, then restart the worker before/after cooperative cleanup | Requester/source is auditable; the workflow is canceled; every unfinished owned row is canceled; accepted and unrelated pending jobs are untouched; no row remains falsely pending with zero live owner. |
| R24 | Blocking activity call ignores cancellation after its Temporal attempt ends | Hold the provider seam past the cooperative grace window while another activity waits | The late writer remains fenced; the abandoned executor generation is observable and retired; fresh bounded capacity runs the next retry/reconciliation activity without a worker restart. |
| R25 | Tailor repeatedly fails after using its inner model-repair budget | Redeliver the activity and start a later retry workflow | Each durable execution advances the outer counter exactly once, inner attempts remain separately auditable, the fifth durable failure becomes non-retryable `exhausted`, and later pickup does not create an infinite retry/spend loop. |
| R26 | Current score is below the live materials threshold | Complete or replay preparation, then lower the threshold or request an explicit per-job low-fit override | Tailor, Cover, and Apply persist non-retryable `skipped` rows with `MIN_SCORE` and the exact score/threshold pair; replay is idempotent; hard blockers take precedence; only threshold-owned skips reset when policy permits work; no Apply attempt starts. |

## Execution Order

1. Prove R01-R04 before destructive faults.
2. Run worker/activity faults R05-R10.
3. Run dispatch/history/transport faults R11-R14.
4. Run concurrent setting and dependency faults R15-R18.
5. Run persistence/supervisor/restart-order faults R19-R21.
6. Finish with mixed-state streaming scenario R22, explicit Enrich cancellation
   R23, abandoned-thread capacity recovery R24, retry-budget convergence R25,
   threshold-state convergence R26, and rerun every previously failing
   scenario.

## Evidence Per Scenario

Each run records: isolated paths and ports; owned PIDs; workflow and Temporal run IDs; injected fault timestamp; activity attempts; relevant stage-state counts; recovery event; final workflow status; operations snapshot; and a Pipelines UI assertion. Sensitive payloads, profile content, job descriptions, browser paths, and generated material text are excluded.

## Stop Conditions

Stop and fix immediately when a scenario produces orphaned `running` rows, duplicate accepted work, an unbounded retry, loss of an accepted artifact, a broad upstream rerun, or a UI state contradicted by runtime inventory. Do not accumulate compensating reapers. If a fix needs more than owner identity, one idempotency key, and one reconciliation decision, reassess the stage boundary before adding logic.

## Findings And Repairs

The campaign reproduced independent reliability defects:

1. Profile/preference submissions treated every submitted section as changed. A compensation-only update could therefore enqueue a broad `score -> tailor -> cover` continuation and recompute scores that already existed. Profile writes now compare the requested sections with their persisted values, suppress true no-ops, and continue preparation without forcing rescore.
2. Condition recovery was not durably claimed before dispatch. Concurrent browser-ready notifications could start equivalent recovery work, and a shrinking cohort could change the workflow identity. Matching blocked rows now record a per-row recovery claim transactionally while every episode uses the stable resolved-condition workflow ID; concurrent starts attach to that execution and a later resolved episode may reuse the ID only after completion.
3. Score, tailor, and cover rows entered `running` without recording their activity owner. When the final Temporal activity attempt failed, nothing could safely decide which rows belonged to the dead execution. All three stages now use the same `activityOwner` contract and one owner-scoped reconciliation activity: accept an already committed result or mark only the stopped owner's uncommitted row retryable. The activity owner is the Temporal run ID, so reused workflow IDs cannot claim a later execution's rows.
4. Rescore and retailor recovery initially compared against the latest result, not the baseline owned by the execution. Owner metadata now stores the prior score version or accepted-material generation once and preserves it across every attempt. A newer committed result is therefore acknowledged before any additional model call.
5. Score, tailor, cover, and PDF could lose the acknowledgement after committing output. Replayed activities now reconcile owner-held rows before selector-based batch execution, recognize committed accepted work, and finish the stage without replacing or regenerating it. PDF workflow tests additionally interrupt the worker after the render subprocess starts and prove the replacement worker completes the same execution.
6. A profile change could commit without its continuation event, or dispatch before the API recorded that intent. The profile mutation and outbox event now share one SQLite transaction. A dispatch-intent event commits before Temporal start; startup reattaches and awaits any older intended execution, coalesces only revisions proven never dispatched, and uses a deterministic workflow identity to survive acknowledgement loss.
7. Recovery failure was initially allowed to be swallowed after a finite retry count, which could let a workflow terminalize while its rows remained `running`. Owner reconciliation is now a mandatory durable workflow step. Temporal may keep that step pending while its dependency is unavailable, but the workflow cannot publish a terminal outcome before reconciliation succeeds.
8. The first consolidation of preparation recovery placed the shared activity under a package whose initializer imports the preparation workflow. A clean worker-registry import exposed the resulting circular initialization before deployment. The activity now lives at the neutral infrastructure boundary, and clean worker startup is a required regression check.
9. The campaign's cancellation check proved only that `CancelledError` reached a
   generic activity. It never asserted selected Enrich rows through SQLite, the
   API read model, or the UI. A canceled global Enrich run therefore reset its
   interrupted row to `pending` and left unstarted selected rows untouched. R23
   now persists exact workflow/run ownership, terminalizes the cohort
   cooperatively, reconciles it after restart, and records the Temporal
   requester/source as a separate audit event.
10. Follow-up fault injection exposed four narrower cancellation boundaries:
    the authenticated LinkedIn pre-pass could reset before ownership; an
    abandoned producer could write after cancellation; a failed local cancel
    intent could suppress Temporal's requester; and a trustworthy snapshot
    could commit before Tailor release. Enrich now owns pre-pass rows before
    navigation, seals canceled executions with a terminal lease, conditions
    cleanup on exact workflow/run metadata, records intent and history as
    distinct evidence, and commits snapshot trust plus downstream release in
    one transaction.
11. The guarded restart path exposed two additional preparation handoff gaps.
    Pending pickup used a stale list projection instead of the canonical
    enrichment aggregate, so a reset cohort could be skipped; a repeated bulk
    request could then bypass queued Enrich and start Score. The API also wrote
    the workflow-handle compatibility ID where the worker required the exact
    Temporal execution ID. Pickup now reads canonical enrichment status and
    text, active upstream preparation blocks downstream pickup, and durable
    ownership uses `firstExecutionRunId`. If that execution ID is unavailable,
    Enrich stays pending until the selected activity claims its runtime identity.
12. The authorized recovery exposed a 30-minute Enrich activity timeout that
    was incorrectly interpreted as terminal cancellation. A retry could then
    mark the interrupted row canceled and send the entire selected cohort to
    Score, including rows without usable enrichment. Timeout, worker shutdown,
    and reset now release unfinished ownership for retry; only an explicit
    workflow cancellation terminalizes the exact cohort through a separate
    durable cleanup activity. Downstream selected stages receive only the
    canonical successful job IDs returned by the preceding stage.
13. Authenticated LinkedIn apply-URL recovery shared its attempt cap with the
    normal extraction cascade, so ordinary history could exhaust recovery
    before the authenticated browser ran. Adopted Chrome extensions were also
    blocked correctly but misattributed to the posting as a fatal unsafe URL.
    Apply-URL recovery now has its own three-pass budget. Extension resources
    remain blocked without poisoning the remote navigation, while loopback,
    file, and other non-public destinations remain fatal. The exact live probe
    upgraded a low quarantined snapshot to trusted and released Tailor before
    the bounded cohort recovery was allowed to fan out.
14. Selected Tailor and Cover activities ignored the requested worker count and
    processed large cohorts serially under the same 30-minute activity ceiling.
    They now use bounded deterministic fan-out. Per-job material failures are
    recorded as item diagnostics and a partial batch result, allowing Cover to
    continue only for the Tailor-approved subset instead of retrying or
    stranding successful rows. Explicitly selected batches now receive 30
    minutes per worker wave, capped at 6 hours, while the 2-minute heartbeat
    remains fixed. A Temporal patch marker preserves the old 30-minute timer
    when an already-open history replays.
15. The per-job continuation exposed a Tailoring Policy compare-and-swap that
    treated another job's prompt fingerprint as a user policy change. Parallel
    jobs could therefore pay for generation and then invalidate one another at
    artifact persistence. The rollbackable policy now fingerprints only global
    generation controls, including the complete tailoring-relevant profile
    projection; each artifact records its target-job prompt fingerprint
    separately. Parallel jobs with the same controls reuse one global version,
    while any tailoring-relevant profile or control change advances it and still
    fails stale persistence closed. Application-only profile edits such as
    compensation do not invalidate generated Materials.
16. Adversarial review of that repair exposed three final commit-boundary gaps:
    a profile save could land after generation loaded its snapshot but before
    artifact persistence; selected Tailor/Cover cancellation had already queued
    the full cohort and did not pass a cooperative token into each job; and the
    per-artifact digest covered only a reusable prompt base rather than the exact
    selected message set. Artifact persistence now compares the generation's
    tailoring-relevant profile projection and global policy against canonical
    current data inside the same SQLite write transaction. Selected material
    fan-out schedules one bounded
    worker wave at a time, stops filling slots on cancellation, fences final
    writes and stage transitions against exact ownership, preserves a result
    committed before cancellation, and leaves a successor owner untouched. The
    artifact stores the digest of the exact selected role/content messages,
    including job and retry content.
17. The live per-job recovery then exposed a worker-capacity failure outside the
    durable state machine: provider calls that ignored cancellation survived
    their 30-minute Temporal attempts inside the shared executor. Four such
    threads filled every activity slot, leaving a two-hour queue with a healthy
    poller but zero dispatch. Blocking async activities now use a dedicated
    bounded executor. Cancellation now retires that executor generation before
    its grace wait, closing the race where a server-dispatched retry could enter
    the poisoned generation. A thread that survives the grace window is then
    recorded as abandoned, while exact ownership fences the late writer.
18. The same recovery exposed two Tailor counters being collapsed into one.
    Every generation invocation may use several inner model-repair attempts,
    but the durable stage row repeatedly overwrote its outer execution count
    with that inner count. Failed jobs could therefore remain eligible forever.
    Tailor now advances the durable counter once per execution, records inner
    generation attempts in an append-only audit keyed by execution and durable
    attempt, and becomes non-retryable `exhausted` on the fifth durable failure,
    matching the established Cover contract.
19. The recovered cohort exposed a terminal policy decision that existed only
    in workflow history. A below-threshold Tailor returned `skipped` and emitted
    `StageSkipped`, but the canonical Tailor, Cover, and Apply rows stayed
    `pending`, so the UI advertised work with no possible owner. Score and
    preparation now reconcile the current non-stale score into explicit
    `MIN_SCORE` skips, preserve in-flight and accepted work, let score hard
    blockers take precedence, and reset only threshold-owned skips when a later
    score, threshold, or explicit low-fit override permits work.
20. The final live material drain exposed one legacy entry path that bypassed
    the selected-batch safeguards. A global Tailor/Cover command left
    `jobIds` empty, so a 30-minute activity timeout could abandon the unscoped
    batch and allow its late result to race a newer selected owner. Global
    material starts now freeze the eligible canonical JobIds before Temporal
    starts. They therefore use the existing bounded per-job fan-out, scaled
    worker-wave deadline, cooperative cancellation token, and exact ownership
    fence.

No timer or second scheduler was added. Recovery is one idempotent step in the
workflow that owns the work, plus a durable event dispatch when a setting
resolves an explicit blocking condition. Worker reconciliation also checks only
nonterminal Enrich rows carrying an exact workflow/run owner whose projected run
is already canceled; it never mutates ownerless or unrelated pending work.

## Execution Ledger

| Scenarios | Evidence | Result |
| --- | --- | --- |
| R01, R07-R09, R22 | Preparation/pipeline, score, tailor, cover, render, and mixed-state orchestration suites | Pass: 198 cumulative focused worker tests |
| R02-R04, R11, R15, R17 | Browser-condition selection, transactional claim, deterministic workflow ID, API-startup backstop, no-op/concurrent profile saves | Pass: focused API and worker tests |
| R05, R10, R12, R21 | Disposable production-shaped stack; Temporal, worker, API, and web killed mid-flight and restarted in both failure orders | Pass: each original workflow/run ID completed exactly once and converged in Temporal, SQLite, API health, and the web proxy |
| R06, R19 | Enrichment lease/replay and SQLite unit-of-work interruption coverage | Pass |
| R13 | Temporal dispatch unavailable and synchronous-fallback rejection coverage | Pass |
| R14, R20 | SSE reconnect, operations/projection telemetry, launcher conflict, stale-process, and heartbeat coverage | Pass |
| R16 | LLM retry, timeout, malformed-output, budget, and spend-limit coverage | Pass |
| R18 | Renderer-unavailable retry and hard process-loss seam | Pass |
| R23 | Real Enrich/Tailor/Cover `JobPipelineWorkflow` cancellation; exact selected/unrelated assertions; authenticated pre-pass child-process kill; abandoned-producer and successor-owner races; mixed local/Temporal requester audit; atomic snapshot/Tailor release; canonical restart pickup and exact execution-ID handoff; activity-timeout retry; successful-subset handoff; authenticated-recovery budget and extension-noise guard; selected-material incremental fan-out, cooperative commit fencing, committed-fact preservation, partial continuation, replay-versioned worker-wave deadline, atomic profile/policy comparison, and exact selected-message artifact fingerprints | PASS: focused and cumulative regressions, authorized live recovery, independent review/QA, and refreshed UI proof completed. |
| R24 | Ignored-cancellation thread held past the grace window; distinct Temporal-sync and blocking executors; executor-generation rotation; immediate subsequent activity | Pass: focused abandoned-thread and worker-construction regressions; live recovery exposed and reproduced the zero-dispatch backlog before the fix |
| R25 | Inner Tailor retry exhaustion followed by repeated durable executions, including the fifth-failure boundary | PASS: inner exhaustion leaves outer attempt 1 retryable; two executions retain both complete audit reports; retry re-entry advances cumulatively; durable attempt 5 is `exhausted` and non-retryable; cumulative gates passed. |
| R26 | Below-threshold workflow completion, repeated reconciliation, hard-blocker precedence, threshold lowering, explicit low-fit override, guarded concurrent claim races, and rendered diagnostics | PASS: automated creation/reversal fixtures plus live reconciliation of the active cohort to explicit `MIN_SCORE` skips; no Apply attempt started. |
| Worker composition | Clean import of the complete Temporal workflow/activity registry | Pass: 10 workflows and 23 activities compose without an import cycle |
| API cumulative | Server, profile-event, and JSON-RPC adapter suites, including loopback SSE and startup recovery | Pass: 263 tests |
| Live Pipelines UI | Browser DOM, console, screenshot, and disclosure interaction against the running app | Pass: Enrich precedes Enrichment reconciliation; Render PDF follows Cover letter; no relevant console warning/error |

The process-chaos harness owns exact PID trees, treats zombies as stopped, isolates Temporal persistence and application data, and can vary whether Temporal or the worker dies first. The first harness iterations themselves exposed two false-positive hazards—broad process matching and zombie liveness—which are now regression-protected by the stricter harness.

Live-runtime incident recovery remains intentionally separate from this
isolated campaign and requires explicit authorization plus an exact backup and
cohort guard. The authorized recovery verification exercised the repaired
pickup and ownership handoff without adding personal row content or workflow
identifiers to this plan. The non-destructive Pipelines, job-detail, and
cancellation-audit presentation smoke passed on the running app.
