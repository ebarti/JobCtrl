# Pipeline Reliability Chaos Campaign

- **Status:** Implementation, complete isolated chaos campaign, and live Pipelines UI smoke pass; final independent QA gate pending
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

Every scenario below must prove those five invariants through the database, Temporal history, API operations snapshot, and rendered Pipelines UI. A scenario fails if it needs a manual retry button unless the terminal condition is explicitly non-retryable.

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

## Execution Order

1. Prove R01-R04 before destructive faults.
2. Run worker/activity faults R05-R10.
3. Run dispatch/history/transport faults R11-R14.
4. Run concurrent setting and dependency faults R15-R18.
5. Run persistence/supervisor/restart-order faults R19-R21.
6. Finish with mixed-state streaming scenario R22 and rerun every previously failing scenario.

## Evidence Per Scenario

Each run records: isolated paths and ports; owned PIDs; workflow and Temporal run IDs; injected fault timestamp; activity attempts; relevant stage-state counts; recovery event; final workflow status; operations snapshot; and a Pipelines UI assertion. Sensitive payloads, profile content, job descriptions, browser paths, and generated material text are excluded.

## Stop Conditions

Stop and fix immediately when a scenario produces orphaned `running` rows, duplicate accepted work, an unbounded retry, loss of an accepted artifact, a broad upstream rerun, or a UI state contradicted by runtime inventory. Do not accumulate compensating reapers. If a fix needs more than owner identity, one idempotency key, and one reconciliation decision, reassess the stage boundary before adding logic.

## Findings And Repairs

The campaign reproduced four independent reliability defects:

1. Profile/preference submissions treated every submitted section as changed. A compensation-only update could therefore enqueue a broad `score -> tailor -> cover` continuation and recompute scores that already existed. Profile writes now compare the requested sections with their persisted values, suppress true no-ops, and continue preparation without forcing rescore.
2. Condition recovery was not durably claimed before dispatch. Concurrent browser-ready notifications could start equivalent recovery work, and a shrinking cohort could change the workflow identity. Matching blocked rows now record a per-row recovery claim transactionally while every episode uses the stable resolved-condition workflow ID; concurrent starts attach to that execution and a later resolved episode may reuse the ID only after completion.
3. Score, tailor, and cover rows entered `running` without recording their activity owner. When the final Temporal activity attempt failed, nothing could safely decide which rows belonged to the dead execution. All three stages now use the same `activityOwner` contract and one owner-scoped reconciliation activity: accept an already committed result or mark only the stopped owner's uncommitted row retryable. The activity owner is the Temporal run ID, so reused workflow IDs cannot claim a later execution's rows.
4. Rescore and retailor recovery initially compared against the latest result, not the baseline owned by the execution. Owner metadata now stores the prior score version or accepted-material generation once and preserves it across every attempt. A newer committed result is therefore acknowledged before any additional model call.
5. Score, tailor, cover, and PDF could lose the acknowledgement after committing output. Replayed activities now reconcile owner-held rows before selector-based batch execution, recognize committed accepted work, and finish the stage without replacing or regenerating it. PDF workflow tests additionally interrupt the worker after the render subprocess starts and prove the replacement worker completes the same execution.
6. A profile change could commit without its continuation event, or dispatch before the API recorded that intent. The profile mutation and outbox event now share one SQLite transaction. A dispatch-intent event commits before Temporal start; startup reattaches and awaits any older intended execution, coalesces only revisions proven never dispatched, and uses a deterministic workflow identity to survive acknowledgement loss.
7. Recovery failure was initially allowed to be swallowed after a finite retry count, which could let a workflow terminalize while its rows remained `running`. Owner reconciliation is now a mandatory durable workflow step. Temporal may keep that step pending while its dependency is unavailable, but the workflow cannot publish a terminal outcome before reconciliation succeeds.
8. The first consolidation of preparation recovery placed the shared activity under a package whose initializer imports the preparation workflow. A clean worker-registry import exposed the resulting circular initialization before deployment. The activity now lives at the neutral infrastructure boundary, and clean worker startup is a required regression check.

No timer, polling reaper, or broad database sweep was added. Recovery is one idempotent step in the workflow that owns the work, plus a durable event dispatch when a setting resolves an explicit blocking condition. Temporal supplies delivery; the application does not add a second scheduler.

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
| Worker composition | Clean import of the complete Temporal workflow/activity registry | Pass: 10 workflows and 23 activities compose without an import cycle |
| API cumulative | Server, profile-event, and JSON-RPC adapter suites, including loopback SSE and startup recovery | Pass: 263 tests |
| Live Pipelines UI | Browser DOM, console, screenshot, and disclosure interaction against the running app | Pass: Enrich precedes Enrichment reconciliation; Render PDF follows Cover letter; no relevant console warning/error |

The process-chaos harness owns exact PID trees, treats zombies as stopped, isolates Temporal persistence and application data, and can vary whether Temporal or the worker dies first. The first harness iterations themselves exposed two false-positive hazards—broad process matching and zombie liveness—which are now regression-protected by the stricter harness.

The remaining live-runtime operation is intentionally separate from this isolated campaign: repairing legacy ownerless rows in the user's database and restarting its stack require explicit approval because those rows predate the new owner identity. The non-destructive Pipelines presentation smoke has passed on the currently running app.
