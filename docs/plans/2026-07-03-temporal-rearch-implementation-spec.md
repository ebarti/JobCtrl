# Temporal Rearchitecture — Implementation Spec for Phases P1b–P5

> **Audience:** an external implementing agent (Codex). This document is
> self-contained and prescriptive: follow it literally. Where it says STOP,
> stop and report rather than improvising.
> **Companion:** `docs/plans/2026-07-03-temporal-native-rearchitecture.md`
> (the architectural plan, PR #230) explains WHY. This document says WHAT and
> HOW. If the two disagree, this document wins for implementation detail.
> **Already done — do not re-implement:** P0 (visibility contract & loop
> closure — see §3 for the substrate it gives you) and P1a (LLM retry
> hardening + score attempt cap, PR #231).

---

## 0. How to use this document

1. Implement exactly ONE phase per pull request, in dependency order
   (§0.1). Never combine phases.
2. Before every edit, locate the anchor **by symbol name** (grep/ripgrep).
   Line numbers in this doc are hints captured 2026-07-03 and WILL have
   drifted. If a named symbol does not exist, STOP and report — do not
   guess, do not create a lookalike.
3. Each phase section has: Objective, Preconditions, Branch/PR names, Files
   you may touch, Files you must NOT touch, numbered Work Items, Deletions
   (each with a pre-deletion check), Tests, and a binary **Definition of
   Done** checklist. A phase is complete only when every Definition of Done
   item is checked and every verification command passes with the stated
   result.
4. Deletions are mandatory, not optional cleanup. This project's standing
   rule is rip-and-replace: the legacy path a phase replaces must be deleted
   in that same phase. Never leave a compatibility shim, a re-export, a
   feature flag guarding old-vs-new, or a "deprecated" wrapper.
5. If a required change appears to force edits outside the phase's "may
   touch" list, STOP and report the conflict instead of expanding scope.

### 0.1 Phase order and parallelism

```
P1b  →  P2 and P3 (parallelizable, disjoint files)  →  P4  →  P5
```

- P1b requires P0 merged.
- P2 requires P0 + P1b merged. P3 requires P0 + P1b merged.
- P2 ∥ P3 is allowed ONLY as two separate sessions/branches. Their "may
  touch" lists are disjoint EXCEPT `infrastructure/rpc/handlers.py` (P3
  edits the three prep handlers; P2 edits the apply dispatch seam) — in
  parallel-session mode sequence P3's handlers.py change first or accept a
  trivial merge; in single-session stacking this is moot. If one session
  does both, do P3 then P2.
- P4 requires P3 merged. P5 requires P4 merged.

**Single-session mode (implementing all phases in one run):** work the
phases as a stacked series in the order **P1b → P3 → P2 → P4 → P5**. The
first branch is cut from `main` (which must already contain P0 + P1a — the
§3 substrate check enforces this); every later phase's branch is cut from
the previous phase's branch, and each PR targets its predecessor's branch
(GitHub retargets to `main` as predecessors merge). In this mode, read
each phase's "merged" precondition as "present in the branch you are
building on". Everything else — one PR per phase, exact branch/PR names,
may-touch lists, deletions, Definition of Done — is unchanged.

### 0.2 Non-negotiable ground rules

- **Never edit code on `main`; never leave `main` dirty.** Do each phase on
  its own branch (fresh from up-to-date `main`, or from the predecessor
  branch in single-session mode), in a clean checkout or worktree.
- Conventional Commits for every commit and PR title.
- Never commit: SQLite databases, `*.pdf`, resumes, cover letters, browser
  profiles, `dashboard.json` with real data, logs, `worker/` runtime dirs,
  API keys. Check `git status` before every commit.
- Never run: `jobhunter apply` against real sites, auto-apply, browser
  submission flows, destructive DB commands. All apply-path testing uses the
  unit/integration harnesses described in the phase specs.
- Do not start the full dev stack (`pnpm dev`) during implementation; use
  the automated suites. (Manual QA steps are listed separately and are run
  by the human/QA gate, not by you, unless a phase explicitly says
  otherwise.)
- Never weaken, skip, or delete a parity or exhaustiveness test
  (`every-event-has-handler.test.ts`, `every-stage-state-has-badge.test.tsx`,
  `AssertEnumExhaustive` type tests). When one fails, it is doing its job:
  fix the registry/handler/badge, not the test.
- Preserve the observability invariant everywhere: the pipeline `Stage*`
  domain events, operational metrics, and OTel spans emitted today via
  `_run_stage_observed` (symbol in
  `workers/automation/src/jobhunter/pipeline/runner.py`) must still be
  emitted with the same semantics after your change. Fixture-compare when in
  doubt.
- **Implicit may-touch closure (all phases).** Two cases are in-scope even
  when a phase's may-touch list omits them, and are NOT stop conditions:
  (a) any file this phase's own Work Items, Deletions, QA gate, or
  Definition of Done explicitly requires you to create or update —
  including docs (`README.md`, `docs/**`) and `pyproject.toml`/`package.json`
  when an allowed work item demands it; (b) when a work item changes a
  component's props/behavior and `git grep` shows exactly ONE consumer file
  outside the component's own folder, that single consumer is in-scope for
  the minimal wiring edit. If there are multiple consumers, or the wiring
  requires a design decision this spec doesn't give, STOP as usual. Never
  use this rule to widen an edit beyond what the requirement itself
  demands; note every use of it in the PR's Deviations section.

### 0.3 Verification command matrix

Run the commands for every surface you touched; the full sweep before
opening the PR.

| Surface | Commands | Required result |
| --- | --- | --- |
| Python worker | `uv --project workers/automation run --extra dev pytest -q` | 100% pass (baseline 2026-07-03: 1678 passed; count grows with your tests) |
| Python lint | `uv --project workers/automation run --extra dev ruff check .` | `All checks passed!` |
| TS API | `pnpm api:check` then `pnpm api:test` | zero errors / all pass |
| Web | `pnpm web:check`, `pnpm --filter @jobhunter/web test`, `pnpm --filter @jobhunter/web test-d` | zero errors / all pass |
| Web e2e (only if a phase says so) | `pnpm --filter @jobhunter/web e2e` | all pass |
| Full sweep (pre-PR, always) | `pnpm test` | all pass |

Note: a trailing gRPC `describe_namespace ... Connection refused` WARNING in
pytest output comes from a temporalio client test with no local server. It
is not a failure.

Note on web e2e (P2/P5): the Playwright config
(`apps/web/e2e/playwright.config.ts`) is self-isolating — it boots its own
API+web on ports 8767/5174 against a temp `JOBHUNTER_E2E_APP_DIR` with
dispatch stubbed; it never touches the live stack on 8766/5173 or real user
data. Before running it, check nothing is squatting 8767/5174 from another
worktree (`lsof -i :8767 -i :5174`); stop only processes you yourself
started — if a foreign process holds a port, use
`JOBHUNTER_E2E_API_PORT`/`JOBHUNTER_E2E_WEB_PORT` to pick free ones.
KNOWN BASELINE: five e2e failures are pre-existing on `main`
(`dashboard.spec.ts:3`, `jobs-drawer.spec.ts:297`, `jobs-drawer.spec.ts:371`,
`route-visual-qa.spec.ts:507`, `token-foundation.spec.ts:349`) — they are
NOT yours to fix and NOT a stop condition; "all pass" for e2e means no NEW
failures beyond those five.

### 0.4 PR / completion report template

Every PR description must contain: **What** (bullet list of changes incl.
deletions), **Why** (one paragraph, reference plan PR #230 and this spec's
phase), **Validation** (every command from §0.3 you ran, verbatim, with its
exact result), **Deviations** (anything this spec said that you did
differently, and why — empty section if none), **Deferred** (anything
explicitly left out, with the phase/owner it was routed to).

---

## 1. Repository orientation (read once)

- Monorepo. TypeScript API: `apps/api/src/`. Web app: `apps/web/src/`.
  Shared contracts: `packages/contracts/src/` (zod). Shared domain types:
  `packages/domain-types/src/`. API client: `packages/api-client/src/`.
  Python worker package: `workers/automation/src/jobhunter/`.
- Execution chain: React web → Fastify API → JSON-RPC 2.0 over a long-lived
  `jobhunter rpc` stdio subprocess (`apps/api/src/json-rpc-adapter.ts` ↔
  `workers/automation/src/jobhunter/infrastructure/rpc/server.py`) → Python
  handlers start Temporal workflows → Temporal worker
  (`jobhunter worker`, entry in `workers/automation/src/jobhunter/cli.py`)
  executes activities → shared SQLite database (WAL mode).
- Events: a single registry of domain event types mirrored EXACTLY between
  Python (`workers/automation/src/jobhunter/domain/events/__init__.py`) and
  TS (`packages/domain-types/src/events/index.ts`). Any new event type must
  land in BOTH in the same PR, plus a web invalidation handler
  (`apps/web/src/contexts/<context>/handlers.ts`, routed through
  `apps/web/src/contexts/operations/invalidation-router.ts`) plus a fixture
  entry (`fixtures/events.ts` under the web test fixtures). The parity tests
  enforce this.
- Projections: derive-from-canonical rebuild in Python
  (`workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py`)
  and TS (`apps/api/src/projections.ts`) sharing one
  `operations_projections` watermark. `workflow_run_projections` and
  `apply_run_projections` are Python-sole-writer; TS only reads them.
- Read model / HTTP: `apps/api/src/read-model.ts` (queries),
  `apps/api/src/write-model.ts` (writes), `apps/api/src/server.ts` (routes).
- Frontend conventions are strict (see `CLAUDE.md` §Frontend Conventions):
  views compose context components; data only via TanStack Query hooks in
  `contexts/operations/`; per-context query keys; mutations own their
  invalidation; no direct `apiClient`/`EventSource`/`localStorage` calls in
  feature code (use ports).

---

## 2. Domain glossary (terms used below)

- **Stage:** one of `discover, enrich, score, tailor, cover, apply` — the
  pipeline steps. Per-job per-stage state rows live in `job_stage_states`
  (SQLite), managed via `set_stage_state` / `ensure_job_stage_rows` in
  `workers/automation/src/jobhunter/state.py` and selectors in
  `database.py`.
- **DiscoveryRun:** aggregate for one source-family crawl.
- **Preparation work item:** row in the durable per-job work queue
  (`preparation_work_items`), keyed by
  `make_preparation_idempotency_key(...)`
  (`workers/automation/src/jobhunter/domain/preparation/work_items.py`) —
  sha256 over (tenant, job, kind, target_version, source_event). P3 replaces
  this queue with per-job workflows but KEEPS the idempotency-key function
  as the workflow-ID source. The queue's lifecycle PORT lives in
  `workers/automation/src/jobhunter/domain/ports/preparation.py` and is
  deleted with the queue (P3).
- **Apply run:** one attempt by the CLI agent (`claude` + Playwright MCP +
  Chrome) to fill/submit one application. Orchestrated by `ApplySaga`
  (`workers/automation/src/jobhunter/domain/apply/process_manager.py` —
  note: DOMAIN layer, not the `apply/` package), launched by
  `workers/automation/src/jobhunter/apply/launcher.py`
  (`acquire_job` claims atomically with `BEGIN IMMEDIATE`; `mark_result`
  finalizes), agent adapter
  `workers/automation/src/jobhunter/infrastructure/apply/claude_code_cli.py`.
- **Reapers (legacy recovery, being deleted):**
  - Reaper #1: `recover_orphaned_running_stages` +
    `recover_orphaned_discovery_runs` (`state.py`), called at worker boot and
    every 15s from the heartbeat loop in `cli.py`. Score/tailor/cover part
    deleted in P3; discover/enrich part deleted in P4.
  - Reaper #2: `_recover_stale_running_items`
    (`workers/automation/src/jobhunter/pipeline/preparation.py`) for
    preparation items. Deleted in P3.
  - Reaper #3: `_rescue_orphaned_running_apply` (`apply/launcher.py`) —
    unconditional running→pending rewind. Deleted in P2.

---

## 3. The substrate you build on (P0 + P1a — already merged before you start)

Verify each of these exists on `main` before starting any phase (grep for
the symbol). If one is missing, STOP and report.

**From P0 (PR #233 — this section reflects what actually shipped):**

- `Workflow*` event family (6 types): `WorkflowStarted`,
  `WorkflowCompleted`, `WorkflowFailed`, `WorkflowCanceled`,
  `WorkflowTimedOut`, `WorkflowTerminated` — in both event registries, with
  web handlers + fixtures. Payload carries `workflow_type`, `workflow_id`,
  `temporal_run_id`, an input summary, terminal status, and error
  code/message/retryable for failures; `WorkflowTerminated`/`WorkflowTimedOut`
  also carry `error_code` (and `WorkflowCanceled` additionally
  `error_message`) — the reconciler stamps `reconciled_not_found` /
  `reconciled_terminated` / `reconciled_closed_<status>` provenance codes.
- `workers/automation/src/jobhunter/infrastructure/temporal/finalize.py`
  exposing activities `record_workflow_started` and
  `record_workflow_outcome`. EVERY workflow you create in P2–P5 must call
  `record_workflow_started` first and run `record_workflow_outcome` on its
  success and failure exits — copy the exact wiring pattern from
  `JobPipelineWorkflow.run`
  (`workers/automation/src/jobhunter/pipeline/workflow.py`). Known P0
  limitations you inherit (P1b fixes them — §4 item 10): in-workflow
  CANCELLATION is currently recorded as `failed` (the workflows catch the
  cancel-induced ActivityError as a stage failure); genuinely-CANCELED
  Temporal executions are mapped to `WorkflowCanceled` by the reconciler; a
  workflow that dies before `record_workflow_started` commits has no
  projection row at all.
- `workflow_run_projections` table (Python-sole-writer; PK `workflow_id`)
  folded by the projection builder under the shared watermark, with
  **first-terminal-wins** semantics (a later terminal event never replaces
  the first — do not rely on re-emitting terminals to "correct" a row); the
  fold upserts, so an outcome without a prior start marker still creates a
  terminal row. TS mirror DDL in `apps/api/src/projections.ts` (TS reads
  only); `listWorkflowRuns` in `apps/api/src/read-model.ts` reads it;
  `GET /v1/workflow-runs/:runId` detail endpoint exists.
- Deterministic workflow IDs + `USE_EXISTING` conflict policy plumbed
  through `WorkflowStartSpec.workflow_id`
  (`workers/automation/src/jobhunter/domain/rpc/messages.py`) and
  `default_workflow_starter`
  (`workers/automation/src/jobhunter/infrastructure/rpc/workflow_starter.py`).
  Shipped scope: SINGLE-JOB apply uses `apply-{sha256(jobUrl)[:16]}`; apply
  batch/continuous and all pipeline/`run_stage` starts still use
  `run-{uuid}` (P2 owns apply batch IDs; P4 owns `discover-{tenant}`).
  Reuse this seam for every new deterministic ID; do not invent a second
  mechanism.
- Reconciler pass inside the worker heartbeat loop (`cli.py`,
  `_worker_heartbeat_iteration`, 15s): open `workflow_run_projections` rows
  are described against Temporal and terminalized when CLOSED or NOT_FOUND,
  with reason stamping (codes above). It re-checks the row inside its write
  transaction and NEVER overwrites an already-terminal row. It only heals
  EXISTING rows. Detection latency for a dead worker's in-flight activity ≈
  the activity's `heartbeat_timeout` (2 min for discover) + one tick.
- JSON-RPC per-request timeout (TS adapter), fetch AbortController
  (`packages/api-client/src/client.ts`), concurrent dispatch in the Python
  RPC server (`infrastructure/rpc/server.py`) with stdout-lock response
  serialization.
- Dead RPC handlers `reset_stage`, `mark_applied`, `mark_skipped`,
  `cancel_stage` are GONE — do not resurrect them. `analyze_job` was KEPT
  (live caller in `apps/api/src/local-actions.ts`); leave it alone.

**From P1a (PR #231):**

- `workers/automation/src/jobhunter/llm.py` retries 429 + all 5xx +
  `httpx.TransportError` with bounded attempts; `_retry_wait` returns a
  finite value in `[0, _MAX_RETRY_WAIT=60]`; jitter applied. Keep this
  contract if you touch retry logic.
- `pending_score` selector in `database.py` caps at `< 5` attempts;
  score failures increment `job_stage_states.attempt_count` (the running
  write threads the current count because `set_stage_state` resets
  `attempt_count` when omitted — preserve that threading if you touch these
  call sites).

---

## 4. Phase P1b — Error inversion & interruptibility

**Objective:** real failures become raised, classified exceptions so
Temporal's retry machinery governs retries; cancellation reaches every
runner and source; activity timeouts stop leaving zombie threads; retry
policies are tuned per stage.

**Preconditions:** P0 and P1a merged to `main`. Verify §3 substrate.

**Branch:** `feat/temporal-p1b-error-inversion` ·
**PR title:** `feat(worker): raise classified errors into Temporal retry and make activities interruptible (P1b)`

**Files you may touch (Python only; no TS/web files in this phase):**
`workers/automation/src/jobhunter/domain/errors.py` (new),
`workers/automation/src/jobhunter/pipeline/runner.py`,
`workers/automation/src/jobhunter/scoring/activities.py`,
`workers/automation/src/jobhunter/enrichment/activities.py`,
`workers/automation/src/jobhunter/materials/activities.py`,
`workers/automation/src/jobhunter/discovery/activities.py`,
`workers/automation/src/jobhunter/profile/activities.py`,
`workers/automation/src/jobhunter/pipeline/workflow.py` (retry policies +
the cancel-path fix of item 10), `workers/automation/src/jobhunter/infrastructure/temporal/run_in_activity.py`,
`workers/automation/src/jobhunter/infrastructure/temporal/worker.py`,
`workers/automation/src/jobhunter/infrastructure/temporal/finalize.py`,
`workers/automation/src/jobhunter/infrastructure/rpc/workflow_starter.py`
and `workers/automation/src/jobhunter/cli.py` (item 10's seam fixes ONLY —
dispatch-time row / reconciler sweep; nothing else in cli.py),
`workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py`
(only if item 10 needs a fold tweak),
`workers/automation/src/jobhunter/enrichment/detail.py` (retryable-status
wiring only), source adapters under discovery for cancel-event plumbing,
plus tests.

**Files you must NOT touch:** `apply/**` (P2 owns it), `llm.py` and the
`pending_score` selector in `database.py` (P1a landed them),
`infrastructure/preparation/**` and `pipeline/preparation.py` (P3 owns
them), anything TS/web.

### Work items

1. **Error taxonomy — new `workers/automation/src/jobhunter/domain/errors.py`.**
   Define exactly:
   ```python
   class JobHunterError(Exception):
       """Base for classified pipeline errors."""
       retryable: bool = True
       code: str = "unknown"

   class ConfigurationError(JobHunterError):   # bad/missing config, bad flags
       retryable = False; code = "configuration"
   class AuthenticationError(JobHunterError):  # 401/403, expired creds
       retryable = False; code = "authentication"
   class MissingInputError(JobHunterError):    # job/profile/artifact absent
       retryable = False; code = "missing_input"
   class TransientNetworkError(JobHunterError): code = "transient_network"
   class BrowserTransientError(JobHunterError): code = "browser_transient"
   class LlmTransientError(JobHunterError):     code = "llm_transient"
   class SourceUnavailableError(JobHunterError):code = "source_unavailable"
   ```
   Plus one helper used by every activity wrapper:
   ```python
   def to_application_error(exc: Exception) -> temporalio.exceptions.ApplicationError
   ```
   which maps a `JobHunterError` to
   `ApplicationError(str(exc), type=exc.code, non_retryable=not exc.retryable)`
   and any other exception to a retryable
   `ApplicationError(..., type="unclassified")`. The `type` string is what
   retry policies filter on — keep the `code` values above verbatim; P0's
   `record_workflow_outcome` persists them as `error_code`.

2. **Stop swallowing in the stage runners.** In `pipeline/runner.py` there
   is a block of per-stage `try/except Exception` handlers (hint: lines
   ~1717–1807 as of 2026-07-03; locate by the pattern
   `{"status": f"error` / `"error: "` returns) that converts every
   exception into a normal `{"status": "error: ..."}` return. Change each
   so that after `_run_stage_observed` has recorded the failure (StageFailed
   event, metrics, OTel span — this recording MUST remain), the exception
   propagates instead of being converted to a status string. Business
   no-ops ("no pending jobs", empty batches) remain normal returns — an
   empty work set is NOT an error. Classify at the raise site where the
   information exists (e.g. missing profile → `MissingInputError`; HTTP 401
   from a source → `AuthenticationError`; timeout/reset → 
   `TransientNetworkError`).

3. **Activity wrappers raise.** Each activity wrapper in the five
   `*/activities.py` files currently returns the runner's result dict
   unconditionally. Change the pattern to:
   ```python
   try:
       result = <existing runner call>
   except JobHunterError as exc:
       raise to_application_error(exc) from exc
   except Exception as exc:
       raise to_application_error(exc) from exc
   ```
   and, for any runner that still reports failure via a status field
   rather than raising (there must be none left after item 2 — treat a
   surviving one as a bug to fix at its source), raising is the contract.
   Successful results keep their exact current return shape (workflow code
   reads them).

4. **Per-stage retry policies** in `pipeline/workflow.py`. Replace the
   single `_DEFAULT_RETRY` usage with per-stage policies:

   | Stage | maximum_attempts | initial_interval | backoff | maximum_interval |
   | --- | --- | --- | --- | --- |
   | enrich | 3 | 5s | 2.0 | 60s |
   | score | 3 | 5s | 2.0 | 60s |
   | tailor | 3 | 10s | 2.0 | 120s |
   | cover | 3 | 10s | 2.0 | 120s |
   | discover | 1 (unchanged — P4 owns resumption) | — | — | — |

   Every policy sets
   `non_retryable_error_types=["configuration", "authentication", "missing_input"]`
   (the `type` strings from item 1). Do not change activity
   `start_to_close`/`heartbeat` timeouts in this phase.

5. **Kill the zombie-thread path.** In
   `infrastructure/temporal/run_in_activity.py`, the blocking work is run
   with an `asyncio.shield(...)` over an executor future; on activity
   timeout/cancel the shielded thread keeps running forever (double
   billing, overlap). Replace with:
   - a dedicated, bounded `ThreadPoolExecutor` owned by the worker (see
     item 7) — never the default executor;
   - on cancellation request: set the work's `cancel_event`, then wait up
     to `cancel_wait` seconds (parameter, default 30) for the thread to
     finish; if it finishes, re-raise `CancelledError` cleanly; if it does
     NOT finish, log a structured `abandoned_thread` warning with the
     activity name and job context, increment an operational metric, and
     re-raise — the thread is explicitly recorded as abandoned instead of
     silently shielded.
   - Heartbeating behavior (periodic heartbeat while the thread runs)
     stays.
   - Rewrite the module docstring while you are in there — it still
     describes wrapping a legacy `run_pipeline(...)` call; that stale
     mention must go (P5's final `run_pipeline` grep depends on it).

6. **Cancellation reaches every runner.** A `cancel_event`
   (`threading.Event`) parameter already exists on parts of the discovery
   path but is only honored by the JobSpy source. Thread it through
   `_run_discovery_source` (`pipeline/runner.py`) into EVERY source-family
   adapter (JobSpy, ATS API, Workday, smart-extract) — each adapter must
   check the event between pages/requests/items and return promptly when
   set — and through the enrichment loop in `enrichment/detail.py`
   (between jobs) and the score/tailor/cover batch loops (between jobs).
   Every activity wrapper passes its cancel event (the one
   `run_in_activity` sets on cancellation) down.

7. **Bounded worker concurrency.** In `infrastructure/temporal/worker.py`
   (`build_worker`), add `max_concurrent_activities` (default 4; read from
   an env var `JOBHUNTER_MAX_CONCURRENT_ACTIVITIES` if set) and pass a
   dedicated `activity_executor` `ThreadPoolExecutor(max_workers=
   max_concurrent_activities + 2)`. This bounds SQLite write contention
   ahead of P3's fan-out.

8. **Enrichment retryable statuses.** `enrichment/detail.py` defines a
   `_RETRYABLE_STATUSES` set that is currently dead (never read). Wire it:
   HTTP statuses in that set raise `TransientNetworkError`; statuses
   outside it (4xx) raise `MissingInputError` or fail the single item
   without raising (matching current per-item semantics — one bad job must
   NOT fail the whole enrichment activity; per-item failures are recorded
   per item exactly as today). Only systemic failures (browser died,
   network gone, auth) escape the loop as exceptions.

9. **Score-cap parity in the streaming runner (routed from P1a, PR #231
   "Known follow-up").** `_PENDING_SQL["score"]` in `pipeline/runner.py`
   lacks the `< 5` attempts cap that the `pending_score` selector now has,
   so `_count_pending("score")` over-counts capped-out jobs and the stage
   can end "stuck" instead of "done" after 3 no-op passes. Add the same
   effective-attempts predicate the selector uses (join/state source must
   match `database.py`'s `pending_score` exactly — read it first). Test:
   a job with 5 failed score attempts is excluded from `_count_pending`.

10. **Close the no-projection-row seams; true `WorkflowCanceled` (routed
    from the P0 gates, PR #233).** Three related gaps shipped in P0:
    (a) in-workflow cancellation is recorded as `failed` — the workflows
    catch the cancel-induced ActivityError as a stage failure. With this
    phase's cooperative cancellation (items 5–6) in place, the workflow
    cancel path must record a real `WorkflowCanceled` outcome (finalize
    from the cancellation handler — a detached/shielded finalize call is
    acceptable HERE because the executor is now bounded; update the
    finalize docstring accordingly).
    (b) if the start-marker activity fails before the workflow body runs,
    no projection row nor outcome ever exists (flagged by the P0
    implementer).
    (c) a workflow reaching a terminal Temporal state before
    `record_workflow_started` commits is invisible forever — the
    reconciler only heals EXISTING rows (found live by QA).
    Fix (b)+(c) with either or both of: write the open row at DISPATCH
    time in `default_workflow_starter` (the worker-side start marker
    becomes a harmless duplicate upsert), and/or extend the reconciler
    with a bounded list-based sweep (Temporal `list_workflows` filtered to
    the task queue, capped page size) that backfills rows for executions
    the projection doesn't know. Whichever you choose, the invariant to
    prove: EVERY dispatched workflow is visible in `/runs` and reaches a
    terminal projection state, even if it dies or is canceled before its
    first activity.

### Deletions

- The swallow branches in `pipeline/runner.py` (item 2) — after this phase
  `grep -n '"error: ' workers/automation/src/jobhunter/pipeline/runner.py`
  returns no stage-runner catch-all conversions (targeted per-item error
  records inside loops are fine; whole-stage catch-alls are not).
- `asyncio.shield` usage in `run_in_activity.py` — 
  `grep -n "asyncio.shield" workers/automation/src/jobhunter/infrastructure/temporal/run_in_activity.py`
  returns nothing. SCOPE NOTE: two other shield references exist in the
  repo and are NOT yours — the cancellation-drain in `apply/activities.py`
  (P2 deletes it; `apply/**` is on your must-NOT-touch list) and a prose
  mention in `finalize.py`'s docstring (rewritten by your item 10). Do not
  attempt a repo-wide empty grep in this phase.

### Tests (all in `workers/automation/tests/`)

1. Taxonomy: each error class → `to_application_error` produces the right
   `type` and `non_retryable` flag; unknown exception → retryable
   `unclassified`.
2. Per activity wrapper (at least scoring + enrichment + one materials):
   runner raising `ConfigurationError` → workflow test env observes
   `ApplicationError` with `non_retryable=True` and EXACTLY 1 attempt;
   runner raising `TransientNetworkError` twice then succeeding → 3
   attempts total, workflow completes. Use the existing Temporal Python
   test-environment patterns already present in the test suite (grep
   `WorkflowEnvironment` for the pattern to copy).
3. Observability invariant: on a raised failure, the `StageFailed` event
   row is still written with the same payload fields as before the change
   (fixture-compare against a pre-change golden fixture).
4. Cancellation: start a long-running fake source under
   `run_in_activity`; cancel; assert the thread observed `cancel_event`
   and exited within `cancel_wait`; assert clean `CancelledError`. Also:
   a fake source that IGNORES the event → assert the `abandoned_thread`
   warning/metric fires and cancellation still completes.
5. Every source adapter: cancel event set mid-iteration → adapter returns
   early (one test per adapter with a stub transport).
6. `_count_pending("score")` excludes a job with 5 failed attempts;
   includes one with 4.
7. Item 10: canceled workflow → projection row reaches `canceled` (not
   `failed`) with the cancel recorded by the workflow's own finalize; a
   workflow killed/canceled BEFORE its start marker still becomes visible
   and terminal in `workflow_run_projections` (via dispatch-time row or
   reconciler sweep — whichever you implemented).

### Definition of Done

- [ ] All §0.3 Python commands pass; full `pnpm test` passes (no TS files
      changed — still run it).
- [ ] `grep -n "asyncio.shield" workers/automation/src/jobhunter/infrastructure/temporal/run_in_activity.py`
      → empty (repo-wide shield removal completes in P2, which owns the
      remaining `apply/activities.py` occurrence).
- [ ] Whole-stage exception-to-status conversions removed (deletion check
      above).
- [ ] A forced transient failure in a workflow integration test retries
      per policy and recovers; a forced `ConfigurationError` fails the
      workflow on attempt 1 with `error_code="configuration"` recorded in
      `workflow_run_projections` (via P0's finalize).
- [ ] Cancel lands within `cancel_wait` in the cancellation tests; the
      ignore-event case records `abandoned_thread`.
- [ ] Item 10 proven: user cancel → `canceled` row; pre-start-marker
      death/cancel → still visible + terminal (the two new tests).
- [ ] `Stage*` event fixtures unchanged (observability invariant).
- [ ] Docs updated: `docs/architecture.md` (error taxonomy table + retry
      policy table + bounded executor/cancellation semantics),
      `docs/local-reliability-qa.md` (new regression rows: transient
      recovery, non-retryable fail-fast, cancel responsiveness).
- [ ] PR description follows §0.4.

---

## 5. Phase P2 — Apply safety (at-most-once + configurable approval gate)

**Objective:** the apply path becomes at-most-once under all crash/retry
interleavings; dry-run is physically unable to submit at the browser layer;
live submission optionally (default ON) requires a recorded human approval,
enforced in the atomic claim; every run leaves inspectable evidence.

**Preconditions:** P0 + P1b merged. Verify §3 substrate.

**Branch:** `feat/temporal-p2-apply-safety` ·
**PR title:** `feat(apply): at-most-once submission, binding configurable approval gate, browser-layer dry-run (P2)`

**Files you may touch:** everything under
`workers/automation/src/jobhunter/apply/` (`launcher.py`, `activities.py`,
`workflow.py`, `chrome.py`),
`workers/automation/src/jobhunter/infrastructure/apply/claude_code_cli.py`
(the agent adapter),
`workers/automation/src/jobhunter/infrastructure/scoring/criteria_provider.py`
(the dashboard-settings reader),
AND everything under `workers/automation/src/jobhunter/domain/apply/` —
`process_manager.py` (ApplySaga) lives HERE in the domain layer, not under
`apply/`; `workers/automation/src/jobhunter/infrastructure/rpc/handlers.py`
(the APPLY dispatch seam ONLY — `apply_action` / `_apply_workflow_id` and
the apply branch of the pipeline spec builder; item 1's workflow_id change
happens HERE, since the start spec is built at dispatch time and the
apply-layer files only receive the payload after the workflow started);
`workers/automation/pyproject.toml` (ONLY if the CDP client of item 7
genuinely needs a new dependency); one COMMENT-ONLY edit in
`workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py`
(a stale comment describing the deleted `release_lock` rewind, hint
~:1998); `database.py` (init_db
ensure-block ONLY), the event registries + web handlers/fixtures (for the
one new event type, item 3), `packages/contracts/src/schemas.ts`,
`apps/api/src/read-model.ts`, `apps/api/src/write-model.ts`,
`apps/api/src/server.ts` (settings + decision routes only),
`apps/api/src/application-feedback.ts`, and in the web app: the settings
form, `ApplyReviewView`, `JobActions`, apply-context components/hooks, plus
tests/fixtures/stories for those;
`apps/web/src/views/jobs/JobDetailDrawer.tsx` (the ONLY `JobActions`
consumer outside its own context, verified by `git grep` on main — the
view-level composition point where item 4's approval-aware "Apply" routing
is wired: read the setting via the existing settings read hook at the
view/composition layer and pass it into `JobActions` as a prop; minimal
wiring edit only); and the docs this phase's Definition of Done requires:
`README.md` (repo root), `docs/architecture.md`,
`docs/local-reliability-qa.md`, `docs/decisions.md`.

**Files you must NOT touch:** `pipeline/runner.py`, `scoring/**`,
`materials/**`, `enrichment/**`, `discovery/**`,
`infrastructure/preparation/**`, `pipeline/preparation.py` (P3 owns these);
`cli.py` (P5 owns it).

### Work items

1. **Deterministic apply workflow IDs.** Apply workflow starts get
   `workflow_id = f"apply-{tenant_id}-{job_key}"` (job_key = the same
   stable job identifier the apply tables key on — locate how
   `apply_action` in `infrastructure/rpc/handlers.py` identifies the job
   and reuse that exact value), via the P0 `WorkflowStartSpec.workflow_id`
   seam with `USE_EXISTING`. A second click while a run is live returns
   the running handle — surface "already running" (the P0 dispatch path
   already does this; just confirm it holds for apply and add a test).

2. **Live submission is at-most-once at the retry-policy level.** In
   `apply/workflow.py`, the activity executing a LIVE (non-dry-run)
   attempt must have `RetryPolicy(maximum_attempts=1)`. Dry-run attempts
   may keep `maximum_attempts=2`. Recovery of an ambiguous live crash
   NEVER goes through blind retry — it goes through item 5.

3. **Durable submit-intent (one new event type).** Add ONE new domain
   event `ApplySubmitIntended` (payload: tenant, job key, apply run id,
   artifact/material version in use, timestamp) to BOTH registries + web
   handler + fixture, exactly the way P0 added the `Workflow*` family
   (copy that commit's file list; the parity tests will catch any missed
   surface). In `ApplySaga.run` (`domain/apply/process_manager.py`), immediately
   BEFORE the agent is allowed to perform submission (the seam is the
   no-op `save` call right before `submit_application` — hint line ~213/218),
   write `ApplySubmitIntended` durably (committed transaction) and
   persist the saga step. Replace `_NoopApplyRunRepository`
   (`apply/launcher.py`, hint ~:822) with the real SQLite-backed apply-run
   repository so saga steps persist as they happen, not in-memory until
   run end. If no real repository class exists yet, implement one against
   the existing apply-run tables (locate the table the projections read).
   Dry-run runs do NOT write `ApplySubmitIntended`.

4. **Configurable approval gate — settings plumbing (default TRUE).**
   New boolean setting `applyApprovalRequired`, stored in `dashboard.json`
   beside `autoApply`, mirrored end-to-end. Copy the `autoApply` pattern
   at every layer:
   - `packages/contracts/src/schemas.ts`: add to
     `SettingsUpdateRequestSchema` (hint ~:1548–1559) and the
     `DashboardSettings` shape (hint ~:2700–2716).
   - `apps/api/src/read-model.ts`: `DEFAULT_SETTINGS` (hint ~:98–106) gets
     `applyApprovalRequired: true`; `normalizeSettings` (hint ~:5054–5070)
     gets
     `applyApprovalRequired: normalizeBool(source.applyApprovalRequired ?? source.apply_approval_required, true)`.
   - `apps/api/src/write-model.ts`: `writeSettingsConfig` (hint ~:631–668)
     round-trips the field.
   - Web settings form (`settings-form.tsx`, clone the autoApply toggle
     block, hint ~:243–255):
     - Label: `Require approval before live submit`
     - Sublabel: `Live (non-dry-run) applications must be approved in Apply Review before the agent may submit.`
     - When toggled OFF, render a persistent warning with `role="alert"`:
       `Approval gate is off: the agent may submit applications to employers immediately after claiming a job, without human review.`
   - Conditional affordances: when the gate is ON, the apply-review view
     (`ApplyReviewView.tsx`, hint ~:994) shows approve-to-submit as the
     primary action and `JobActions.tsx` (hint ~:41–42) routes "Apply"
     into the review flow instead of immediate fire; when OFF, current
     one-click behavior. UI state is cosmetic — the backend (item 6) is
     the actual gate.

5. **Intent-aware recovery replaces reaper #3.** Delete
   `_rescue_orphaned_running_apply` and its call site (hint
   `launcher.py:1460–1494`, called near `:1271`) and the unconditional
   `release_lock` rewind (hint `:586`). New recovery rule, evaluated at
   apply-batch start AND exposed as a small function the P0 reconciler
   path can call: for an apply row in `running` whose workflow is
   terminal-or-gone (per `workflow_run_projections`):
   - if `ApplySubmitIntended` exists for that run and no terminal
     submit result was recorded → set the application to a new
     `needs_verification` state, surfaced in the Apply Review queue.
     NEVER auto-requeue to pending. A human resolves it (mark applied /
     mark failed / re-approve), using existing review actions.
   - if NO intent exists → safe rewind to `pending` (the agent never got
     near submission).
   Adding `needs_verification`: locate the apply/application status union
   in `packages/contracts` (grep `needs_verification` first to confirm it
   does not already exist; then grep the existing apply statuses, e.g.
   whatever `apply_run_projections.status` / the apply-review queue
   filters use), add the value to the TS union + zod, the Python mirror
   (grep the same literal set in `workers/automation/src/jobhunter/`),
   the web badge map for that union, and its fixtures/stories. Compile
   errors and exhaustiveness tests will enumerate every switch you must
   update — fix them all; do not suppress.

6. **Gate enforcement inside the atomic claim.** Thread
   `approval_required: bool` from the settings read into the claim:
   - Python reads the setting fresh per claim via a small extension of
     `infrastructure/scoring/criteria_provider.py`
     (`LocalScoringCriteriaProvider._read_settings` already reads
     `dashboard.json`; add the new field there or in a sibling reader,
     default True when absent).
   - Thread it like the existing `min_score` parameter:
     `ApplyActivityInput` (`apply/activities.py`, hint :19–36) →
     `launcher.main` (imported as `apply_main` at `apply/activities.py:63`
     and called at `:75`; the function itself is `launcher.py`, hint
     :1229) → `acquire_job` (hint :181).
   - Inside `acquire_job`'s `BEGIN IMMEDIATE` transaction (guard location
     hint :288–343), when the claim is for a LIVE run and
     `approval_required` is true: `SELECT decision FROM
     application_review_decisions WHERE <job predicate> ORDER BY
     created_at DESC, id DESC LIMIT 1` — proceed only if it equals
     `approve_submit`; otherwise rollback/skip that job (leave it
     pending), record the skip reason in the existing skip/log channel so
     the UI can show "awaiting approval". Dry-run claims bypass the gate.
     The SELECT must run INSIDE the claim transaction (race-safety).
   - **F1 (required):** `application_review_decisions` is today created
     lazily only by the gmail feedback path
     (`workers/automation/src/jobhunter/infrastructure/gmail/feedback.py`,
     DDL hint :252–261). Register the same DDL in `init_db`'s ensure-block
     (`database.py`, hint :233–253) so the gate never hits a missing
     table.
   - **F2 (required):** verify the web "Approve" action actually INSERTs
     a committed `approve_submit` row (trace:
     `packages/contracts/src/schemas.ts` decision literals →
     `apps/api/src/application-feedback.ts` (hint ~:334) →
     `read-model.ts` (hint ~:1715)). If any link is missing (the UI is
     currently decorative), implement the missing route/write so the
     decision persists. Add an API test: POST approve → row exists →
     subsequent claim passes the gate.

7. **Browser-layer dry-run enforcement.** In `apply/chrome.py` (launch
   seam hint :214–247): after launching Chrome with a CDP port, when the
   run is dry-run, open a CDP session (websocket; add a small dependency
   only if the repo has none — check `pyproject.toml` for an existing
   websocket client first) and:
   - `Fetch.enable` with `patterns=[{"urlPattern": "*", "requestStage": "Request"}]`;
     on `Fetch.requestPaused`: if `request.method` in {POST, PUT, PATCH}
     and the target host is NOT localhost/127.0.0.1 → 
     `Fetch.failRequest(errorReason="BlockedByClient")`; else
     `Fetch.continueRequest`.
   - `Page.addScriptToEvaluateOnNewDocument` installing a script that
     overrides `HTMLFormElement.prototype.submit` and captures
     `submit` events (`preventDefault` + mark a
     `window.__jobhunter_dryrun_blocked` flag) on every new document.
   The interceptor must attach to new targets/frames
   (`Target.setAutoAttach` or re-attach on target creation). Keep the
   prompt-text dry-run instruction too — defense in depth — but the CDP
   layer is the guarantee. Success criterion: an integration test drives
   a real headless Chrome (the repo already launches Chrome in apply
   tests — reuse that harness; if only mocks exist, build the test
   against a local HTTP server acting as the "employer") with a page that
   auto-POSTs on load and a form-submit button; under dry-run, the local
   server receives ZERO POST/PUT/PATCH; under live mode, it receives
   them.
8. **Evidence capture + honest confidence.** Persist, for every run:
   the agent's raw output (`AgentResult.raw_output`) and, when the agent
   reports success, a confirmation snapshot (screenshot or final-page
   HTML — whichever the existing artifact pipeline supports; grep
   `job_artifacts` for the artifact-writing helper) as `job_artifacts`
   rows with kinds `apply_agent_output` and `apply_confirmation`. Replace
   the hardcoded `verification_confidence=1.0`
   (`infrastructure/apply/claude_code_cli.py`, hint :364) with a derived
   value:
   `1.0` only when a structured `RESULT: APPLIED` AND a confirmation
   artifact exist; `0.6` when only the structured result exists; `0.2`
   when the outcome was inferred from unstructured output. Persist it
   where it is persisted today.
9. **Continuous mode via continue-as-new.** In `apply/workflow.py`, the
   continuous loop must `workflow.continue_as_new(...)` after at most 25
   iterations or 1 hour of workflow time, carrying its cursor/settings in
   the continue-as-new args. This removes the silent ~4h death (2h
   timeout × 2 attempts). Add a workflow test asserting continue-as-new
   fires at the bound.

### Deletions

Symbol-removal checks are scoped to `workers/automation/` (source AND
tests — the tests that exercise a deleted symbol are deleted or rewritten
in this same phase, e.g. in `test_apply_regressions.py` /
`test_apply_saga.py`; they must not survive referencing dead code).

- `_rescue_orphaned_running_apply` (+ call site) — replaced by item 5.
  Afterwards `grep -rn "_rescue_orphaned_running_apply" workers/automation/`
  → empty.
- Unconditional rewind path INSIDE `release_lock` (the running→pending
  reset branch) — the `release_lock` function itself REMAINS for the
  normal completed-run unlock, so there is deliberately NO empty-grep for
  this one. Removal is proven behaviorally: the old rewind regression
  tests are replaced by the intent-aware recovery tests. Also fix the one
  stale comment referencing the rewind in `projection_builder.py`
  (comment-only edit, explicitly allowed).
- `_NoopApplyRunRepository` — replaced by the real repository (item 3).
  Afterwards `grep -rn "_NoopApplyRunRepository" workers/automation/` →
  empty.
- `mark_orphans_as_failed` (`domain/apply/process_manager.py`, hint :354;
  also drop its mention in the class docstring, hint :33) — dead code
  today; delete. Afterwards
  `grep -rn "mark_orphans_as_failed" workers/automation/` → empty.
- The `asyncio.shield` cancellation-drain in `apply/activities.py` (hint
  ~:95–:103) — replace with the P1b bounded-executor/cooperative-deadline
  pattern when reworking apply-activity cancellation. Afterwards
  `grep -rn "asyncio.shield" workers/automation/src/jobhunter/apply/` →
  empty (this completes the repo-wide shield removal P1b deliberately
  left unfinished).

### Tests

Python: gate ON blocks an unapproved live claim inside `acquire_job` (job
stays pending, skip reason recorded) and admits an approved one; gate OFF
one-click claim; dry-run claim bypasses the gate; latest-decision-wins
(approve then decline → blocked); kill-after-intent simulation → recovery
parks `needs_verification` and a subsequent apply batch does NOT re-claim
it; kill-before-intent → rewound to pending and re-claimable; live activity
`maximum_attempts == 1` (assert on the policy object); continue-as-new
bound; confidence derivation matrix (3 cases); CDP dry-run integration test
(zero POST/PUT/PATCH cross-origin); `init_db` creates
`application_review_decisions` on a fresh DB.
TS/web: settings round-trip (`applyApprovalRequired` default true through
GET/PUT settings + `normalizeSettings` including the `apply_approval_required`
snake-case fallback); approve action inserts a decision row (API test);
apply-review renders `needs_verification` bucket; toggle OFF renders the
`role="alert"` warning (a11y test); parity/exhaustiveness suites green with
the new event + status; one mutation-hook test per new mutation (success +
rollback) per frontend conventions.

### QA gate (run by the human/QA agent — list these steps in the PR)

Blocker-level checks: fresh install (delete local `dashboard.json`) →
settings show approval REQUIRED by default; with gate ON, calling the apply
API directly (bypassing the UI) leaves the job unclaimed/pending —
UI-bypass proof; with gate ON, approve in /apply-review → next apply batch
claims and (dry-run) completes; toggle OFF → warning visible; dry-run
against the QA fixture site produces zero submissions; evidence artifacts
(agent output + confirmation) visible for a completed run;
`needs_verification` row appears when a run is killed after intent (fault
injection) and is resolvable from the UI.

### Definition of Done

- [ ] Full §0.3 matrix green, including web e2e for the settings toggle +
      apply-review flow.
- [ ] All Deletions-section checks pass: the three symbol greps empty
      within `workers/automation/`; apply-scoped `asyncio.shield` grep
      empty; `release_lock` still present minus its rewind branch.
- [ ] Fresh-DB test proves the decisions table exists via `init_db`.
- [ ] The CDP integration test proves zero cross-origin POST/PUT/PATCH in
      dry-run with a hostile page.
- [ ] Kill-after-intent fault test proves no second submission attempt.
- [ ] `README.md` (repo root) safety notes + new setting; `docs/architecture.md`
      apply section; `docs/local-reliability-qa.md` apply regression
      matrix rows (the QA gate list above); `docs/decisions.md` ADR
      "At-most-once apply: intent event + needs_verification + browser-layer
      dry-run + configurable binding approval gate (default required)".
- [ ] PR description per §0.4.

---

## 6. Phase P3 — Per-job preparation workflows

**Objective:** replace the pull-based preparation work-item queue with one
durable `JobPreparationWorkflow` per job; Temporal owns retry, recovery,
and idempotency for score → tailor → cover → pdf.

**Preconditions:** P0 + P1b merged. (P2 not required.)

**Branch:** `feat/temporal-p3-preparation-workflows` ·
**PR title:** `feat(worker): per-job JobPreparationWorkflow replaces the preparation queue (P3)`

**Files you may touch:**
`workers/automation/src/jobhunter/preparation/workflow.py` (new; or the
package the repo's workflow modules conventionally live in — mirror
`pipeline/workflow.py`'s location pattern),
`workers/automation/src/jobhunter/scoring/{scorer.py,tailor.py,cover_letter.py,activities.py}`,
`workers/automation/src/jobhunter/materials/activities.py`,
`workers/automation/src/jobhunter/infrastructure/temporal/registry.py`,
`workers/automation/src/jobhunter/infrastructure/rpc/handlers.py`
(the three prep-related handlers only),
`workers/automation/src/jobhunter/pipeline/runner.py` (ONLY the
`finish_discovery` drain call and prep fan-out seam),
`workers/automation/src/jobhunter/pipeline/preparation.py`,
`workers/automation/src/jobhunter/infrastructure/preparation/sqlite_repository.py`,
`workers/automation/src/jobhunter/state.py` (ORPHAN_RECOVERY_STAGES only),
`workers/automation/src/jobhunter/domain/preparation/work_items.py`
(read-only reuse — keep `make_preparation_idempotency_key`),
`workers/automation/src/jobhunter/domain/ports/preparation.py` (delete the
queue-lifecycle port methods together with their sole implementation —
required for the `claim_next` deletion grep to be satisfiable), plus tests.

**Files you must NOT touch:** `apply/**` (P2), `llm.py`, discovery source
adapters and `_run_discovery_source` (P4), `cli.py` (P5), any TS/web file
(no contract changes in this phase — the P0 runs UI already renders any
workflow type).

### Work items

1. **`cover_letter_by_url` extraction (fixes a real crash bug).**
   `run_cover_letters` (hint `scoring/cover_letter.py:157`) processes a
   batch and COMMITS ONCE at the end (hint `:318`) — a mid-batch crash
   loses every completed job's stage state. Extract a per-job function
   `cover_letter_by_url(...)` with the same signature family as
   `tailor_job_by_url` (`scoring/tailor.py`, hint :644): does one job,
   commits its own stage state + events, returns the same per-job result
   shape. It must call the existing domain core
   (`GenerateCoverLetterUseCase` — grep it) exactly as the batch loop
   does today. Then delete the batch path (deletion 1).
2. **`JobPreparationWorkflow`.** New workflow, registered in
   `registry.py`, copying the P0 finalize wiring pattern:
   ```python
   @dataclass
   class JobPreparationInput:
       tenant_id: str; job_url: str
       steps: list[str]              # subset of ["score","tailor","cover","pdf"], in this order
       target_version: str; idempotency_key: str
   ```
   Body: `record_workflow_started`; then for each requested step IN ORDER
   run the matching activity (`score_job_activity` → `score_job_by_url`,
   `tailor_job_activity` → `tailor_job_by_url`, `cover_letter_activity` →
   `cover_letter_by_url`, `render_pdf_activity` → `RenderPdfUseCase`
   (grep in `use_cases.py`; hint :3533; it is idempotent and currently
   has zero callers — this phase wires it)); P1b retry policies apply per
   step; a non-retryable failure fails the workflow (finalize records
   it); always finalize. Workflow body stays deterministic — all IO in
   activities. Each step activity is idempotent: it first checks current
   stage state and returns `{"status": "already_done"}` without side
   effects when the target version is already satisfied (the per-job
   cores already behave incrementally — verify and add the check where
   missing).
3. **Deterministic IDs.** Workflow ID = `f"prep-{idempotency_key}"` where
   the key comes from `make_preparation_idempotency_key` exactly as the
   queue computed it (`domain/preparation/work_items.py`, hint :116–134).
   Start with `USE_EXISTING`: a duplicate trigger attaches to the running
   workflow — this REPLACES the queue's INSERT-OR-IGNORE dedup.
4. **Fan-out.** Where discovery finish / batch triggers currently enqueue
   preparation items (the drain seam in `pipeline/runner.py`, hint
   `finish_discovery` → drain at :1416): replace with an activity
   `derive_preparation_targets` returning a deterministic, sorted list of
   `{job_url, idempotency_key, steps}` and start
   `JobPreparationWorkflow` children in batches of 25 (start batch, await
   handles' starts — not results — then next batch). Child starts are
   `USE_EXISTING` so re-derivation is harmless.
5. **RPC handlers.** `rescore_job` / `tailor_job` / `retailor_job`
   (`infrastructure/rpc/handlers.py`, hints :239/:275/:261) start
   `JobPreparationWorkflow` with the appropriate `steps` subset
   (`rescore_job` → `["score"]`; `tailor_job`/`retailor_job` →
   `["tailor","cover","pdf"]` — confirm against what each handler's
   legacy path regenerates today and match it exactly) instead of the
   pipeline workflow. Response shape to TS stays a workflow-run reference
   (P0 contract) — no TS change.

### Deletions (pre-check each with grep for external callers first)

1. `run_cover_letters` batch path (after item 1). No caller remains.
2. The preparation queue machinery: `claim_next`, `complete`, `fail`,
   `retry`, `recover_running` in
   `infrastructure/preparation/sqlite_repository.py`;
   `_recover_stale_running_items` (`pipeline/preparation.py`, hint :458 —
   reaper #2); the drain invocation in `finish_discovery`. If the
   work-items TABLE has other readers (grep the table name), leave the
   table and its writer removal to a follow-up note in the PR; delete the
   queue lifecycle code regardless.
3. In `state.py`: remove `score`, `tailor`, `cover` from
   `ORPHAN_RECOVERY_STAGES` (hint :54). **Do NOT remove discover/enrich
   entries — P4 owns those.** The sweep function itself stays until P4.

### Tests

`cover_letter_by_url`: two-job scenario where job 2 crashes → job 1's
stage state + events are committed (proves the batch-commit bug is fixed).
Workflow: runs steps in order; skips `already_done` steps; step failure
(non-retryable) fails the workflow with finalize recording the step in the
error; duplicate start with the same idempotency key attaches
(USE_EXISTING) — no duplicate side effects. Fan-out: derive activity
returns sorted deterministic list; batching starts ≤25 concurrently.
Handlers: each of the three starts the workflow with the right steps.
Fault injection: using the Temporal test environment, kill/restart between
`tailor` and `cover` → workflow resumes at `cover` (score/tailor not
re-run — assert via call counters) and completes; no `running` preparation
rows remain anywhere afterwards.

### Definition of Done

- [ ] Full §0.3 matrix green (run the TS/web suites even though untouched).
- [ ] `grep -rn "claim_next\|_recover_stale_running_items" workers/` →
      empty (excluding tests that were deleted with the code).
- [ ] `ORPHAN_RECOVERY_STAGES` no longer contains score/tailor/cover;
      still contains the discovery-side entries.
- [ ] Kill-mid-prep fault test proves resume-at-failed-step.
- [ ] A crashed cover-letter step no longer loses completed jobs' state
      (the two-job test).
- [ ] Re-tailor from the RPC handler is idempotent (same artifacts, no
      duplicate versions) — assert via the artifact version table.
- [ ] `docs/job-pipeline-architecture.md` (preparation now per-job
      workflows; update the sequence diagram section) and
      `docs/architecture.md` updated.
- [ ] PR description per §0.4.

---

## 7. Phase P4 — Discover decomposition + Schedules (off by default)

**Objective:** discovery becomes a `DiscoverWorkflow` with per-source-family
activities and an enrichment activity, giving real heartbeats, working
cancel across ALL sources, correct circuit-breaker attribution, automatic
resumption after worker death, and (disabled-by-default) Temporal Schedules.

**Preconditions:** P3 merged.

**Branch:** `feat/temporal-p4-discover-decomposition` ·
**PR title:** `feat(discovery): DiscoverWorkflow with per-source activities, real heartbeats, schedules off by default (P4)`

**Files you may touch:** `workers/automation/src/jobhunter/discovery/**`
(including a new `discovery/workflow.py`), `enrichment/detail.py`,
`pipeline/runner.py` (discover paths only),
`domain/discovery/scheduler.py`,
`workers/automation/src/jobhunter/state.py` + `cli.py` (reaper #1 removal
+ schedule bootstrap only), `source_quality.py`,
`infrastructure/temporal/registry.py`, `infrastructure/rpc/handlers.py`
(`run_stage` discover mapping), `config.py` (discovery settings),
`apps/api/src/discovery-controls.ts` + its contracts + the web discovery
settings surface (for `scheduling_enabled` only), and — ONLY to delete
`discovery_run_projections` — BOTH files that define it:
`apps/api/src/projections.ts` and
`workers/automation/src/jobhunter/infrastructure/projections/sqlite_projection_store.py`,
plus tests.

**Files you must NOT touch:** `apply/**`, `scoring/**` cores,
`materials/**`, the preparation workflow from P3 (start it, don't edit it).

(May-touch addition for item 5: `pipeline/workflow.py` — ONLY the
orchestrator's discover phase, which becomes "start child
`DiscoverWorkflow` and await it".)

(May-touch addition — the docs this phase's Definition of Done requires:
`README.md` (repo root), `docs/architecture.md`,
`docs/job-pipeline-architecture.md`, `docs/local-reliability-qa.md`,
`docs/decisions.md`.)

### Work items

1. **`DiscoverWorkflow`** (`discover-{tenant_id}` ID via the P0 seam,
   `USE_EXISTING` — one live discovery per tenant, ever). Body (finalize
   pattern from §3): activity `plan_discovery_sources` returns the
   deterministic list of source families + their configs; then run one
   activity per source family — `_run_discovery_source`
   (`pipeline/runner.py`, hint :436) already owns a complete DiscoveryRun
   aggregate lifecycle per family and is the extraction seam — families
   run in parallel (`asyncio.gather` over `execute_activity` calls)
   EXCEPT any family the current code serializes for rate-limit reasons
   (inspect `_run_discovery_source` call order; preserve any deliberate
   serialization and say which in the PR); then ONE enrichment activity
   (extract `_run_discovery_enrichment_until_idle`, hint runner.py:2058 —
   internal site-batching and per-job commits stay as-is, hint
   `enrichment/detail.py:931`); then the P3 fan-out activity
   (`derive_preparation_targets` + child starts). Per-source retry: P1b
   taxonomy, `maximum_attempts=3` — WITH cancel isolation from P1b this
   is now safe (the old attempts=1 was defensive against zombie
   overlap). Source activities heartbeat REAL progress: serialize the
   family's `DiscoveryRunProgress` (`domain/discovery/scheduler.py`, hint
   :90 — already a serializable frozen dataclass) into
   `activity.heartbeat(progress)` from the progress-record seam
   (`_record_discovery_source_progress`, hint runner.py:728).
2. **Cancel to ALL sources.** P1b threaded `cancel_event` through the
   adapters; verify here that a workflow cancel reaches every family
   (JobSpy, ATS, Workday, smart-extract) and enrichment, and add the
   missing hookups if P1b left any (the old code wired JobSpy only, hint
   runner.py:1557).
3. **Circuit-breaker attribution fix.** Multi-source families report
   `failed_source_id=""` on failure (hint runner.py:545), so
   JobSpy/Workday failures never increment any source's
   `consecutive_failures` (`source_quality.py`, hint :181) and never trip
   quarantine. Attribute every failure to the REAL `source_id` of the
   failing source within the family. Test: three consecutive synthetic
   failures of one Workday source quarantine that source and only that
   source.
4. **Temporal Schedules, disabled by default.** Add
   `scheduling_enabled: bool` (default false) + `schedule_cron: str`
   (default `"0 7 * * *"`, documented as local time) to the discovery
   settings JSON blob (`discovery_settings.search_config_json` — locate
   the Python defaults in `config.py` and the TS read/write in
   `apps/api/src/discovery-controls.ts`; mirror both + the web settings
   surface + zod). On worker startup (`cli.py`, near where the worker
   connects), reconcile: if enabled → create-or-update a Temporal
   Schedule (`temporalio.client.Schedule`) that starts `DiscoverWorkflow`
   with `overlap=ScheduleOverlapPolicy.SKIP`; if disabled → delete the
   schedule if present. Never auto-enable. Schedule state must survive
   the reconcile being run repeatedly (idempotent).
5. **Wire `run_stage discover`** (`infrastructure/rpc/handlers.py`) to
   start `DiscoverWorkflow` directly (not the pipeline orchestrator's
   batch discover). The orchestrator's discover phase becomes "start
   child `DiscoverWorkflow` and await it".

### Deletions (pre-check with grep)

- `_run_discover` batch path in `pipeline/runner.py` (hint :1299) once no
  caller remains.
- Reaper #1 in full: `recover_orphaned_running_stages` +
  `recover_orphaned_discovery_runs` (`state.py`, hints :657/:838) + both
  call sites (`cli.py` boot hint :1379, heartbeat hint :1472) +
  `ORPHAN_RECOVERY_STAGES` constant. (P3 already removed its stages from
  the set; this phase deletes the machinery.)
- `discovery_run_projections` table + its writer (write-only today; grep
  the table name across `workers/ apps/ packages/` to prove zero readers
  first — expected: writer only).

### Tests

Workflow: source families run as independent activities (parallel where
specified); one family failing non-retryably fails only after the others
complete (gather semantics — collect results, then raise aggregate);
enrichment runs after sources; fan-out starts prep children. Heartbeat:
progress payloads reach the test environment's heartbeat capture. Cancel:
workflow cancel → every in-flight family observes its cancel event
(stub adapters assert). Breaker: per-source attribution test (item 3).
Schedules: enabled=false → no schedule exists; enabled=true → schedule
exists with SKIP; toggling off deletes it; reconcile is idempotent.
Fault injection (THE resumption proof): Temporal test env — kill the
worker mid-source-activity, restart → incomplete source activities are
retried and discovery COMPLETES (assert final `WorkflowCompleted` +
discovered jobs present); no reaper needed (it no longer exists).

### Definition of Done

- [ ] Full §0.3 matrix green, including web suites (settings surface).
- [ ] `grep -rn "recover_orphaned_running_stages\|recover_orphaned_discovery_runs\|ORPHAN_RECOVERY_STAGES\|discovery_run_projections" workers/ apps/ packages/`
      → empty.
- [ ] Kill-worker resumption test passes (discovery completes after
      restart with zero manual action).
- [ ] Breaker attribution test passes.
- [ ] Schedule disabled by default on fresh install (test + QA step).
- [ ] QA rows added to `docs/local-reliability-qa.md`: cancel-all-sources,
      quarantine-on-repeated-failure, schedule toggle honors overlap-skip,
      kill-worker discovery resumption (manual variant of the demo in the
      plan doc §Verification).
- [ ] Docs: `docs/job-pipeline-architecture.md` (discover decomposition,
      new sequence), `docs/architecture.md` (Schedules), `README.md`
      (scheduling setting), `docs/decisions.md` (Schedules ADR).
- [ ] PR description per §0.4.

---

## 8. Phase P5 — CLI cutover, spend ceiling, governance

**Objective:** one execution path — every entry point starts workflows;
the in-process pipeline engine is deleted; LLM spend is capped; the last
heavy sync RPC handlers become workflows; docs/ADRs describe the new
reality.

**Preconditions:** P4 merged.

**Branch:** `feat/temporal-p5-cli-cutover` ·
**PR title:** `feat(worker): CLI starts workflows, spend ceiling, delete in-process pipeline (P5)`

**Files you may touch:** `workers/automation/src/jobhunter/cli.py`,
`pipeline/runner.py` (deletions), `pipeline/__init__.py` (drop the deleted
re-exports — `run_pipeline` is re-exported there today),
`workers/automation/src/jobhunter/actions.py` (top-level module, NOT under
`pipeline/`),
`workers/automation/src/jobhunter/profile/**` + compensation module (for
the two new workflows), the five `*/activities.py` default paths,
`llm.py` + agent-SDK client seam (spend recording only), `database.py`
(spend table DDL in init_db), settings plumbing files from P2's list (for
`dailyBudgetUsd`), `infrastructure/temporal/registry.py`,
`infrastructure/rpc/handlers.py` (the two converted handlers),
`docs/**`, `README.md` (repo root, item 6),
`workers/automation/pyproject.toml` (only if a dependency was added),
plus tests. Also allowed: ONE new shared module under
`workers/automation/src/jobhunter/` (e.g. `workflow_specs.py`) for the
extracted spec builders of item 1, and the web operations/health surface
component for item 2's spend-vs-budget line ONLY.

### Work items

1. **CLI starts workflows.** `jobhunter run` (`cli.py`, hint :685), the
   per-stage commands (`_run_stage_command`, hint :507),
   `run_single_job` (`pipeline/runner.py`, hint :2642), and
   `run_local_action` (`workers/automation/src/jobhunter/actions.py` —
   top-level module — hint :175) build the same
   `WorkflowStartSpec`s the RPC handlers build (extract shared spec
   builders into one module both import — do not duplicate ID logic) and
   start them via the Temporal client, then WAIT on the handle and print
   progress/result (CLI UX: stream basic status lines; exit non-zero on
   workflow failure with the `error_code`). If Temporal/worker is
   unreachable: exit immediately with a clear message pointing at
   `jobhunter doctor` (which already probes reachability, hint
   cli.py:1677) — never fall back to in-process execution.
2. **Spend ceiling.** New SQLite table (init_db ensure-block):
   `llm_spend(day TEXT PRIMARY KEY, input_tokens INTEGER NOT NULL DEFAULT 0,
   output_tokens INTEGER NOT NULL DEFAULT 0, estimated_usd REAL NOT NULL DEFAULT 0)`.
   First LOCATE existing usage capture (the OTel/Langfuse LLM spans and
   any usage fields on responses — grep `usage` in `llm.py` and the agent
   SDK client) and hook recording at those existing points (both the
   legacy client and the SDK path); do not double-count. New setting
   `dailyBudgetUsd` (default 25, `0` = unlimited) plumbed exactly like
   P2's setting (all layers). Enforcement: a `check_spend_budget`
   preflight activity (called at the top of every workflow that spends:
   preparation, discover-enrichment, apply, compensation/profile) raises
   non-retryable `BudgetExceededError` (add to the P1b taxonomy,
   `code="budget_exceeded"`, retryable=False) when today's
   `estimated_usd` ≥ budget; finalize keeps recording outcomes normally.
   UI: settings field + a spend-vs-budget line in the operations/health
   surface the API already exposes (extend the health/read-model payload;
   keep it minimal).
3. **Convert the two heavy sync RPC handlers** (`refresh_compensation`,
   `profile_import`) into workflows (`CompensationRefreshWorkflow`,
   `ProfileImportWorkflow`, IDs `run-{uuid}` from the starter, finalize
   pattern, single activity each wrapping the existing implementation
   function with P1b error classification). Their RPC handlers now start
   the workflow and return the workflow-run reference like every other
   dispatch (TS already handles that shape via P0). This removes the last
   head-of-line-blocking sync handlers.
4. **Delete the in-process engine.** Remove the `run_pipeline` execution
   paths from `cli.py`/`actions.py` (item 1 replaced them); remove the
   activity default paths that wrap `run_pipeline` (e.g.
   `scoring/activities.py` hint :81 and the analogous defaults in the
   other four `activities.py`) — after P1b–P4 every activity calls its
   per-domain core directly; then delete
   `run_pipeline`/`_run_pipeline_inner` (`pipeline/runner.py`, hints
   :2422/:2492) once `grep -rn "run_pipeline" workers/` shows zero
   remaining callers. The `_run_stage_observed` observability wrapper
   moves to (or is confirmed already invoked from) the per-domain
   activities so the `Stage*` event/metric/span behavior is unchanged —
   fixture-compare, same invariant as P1b.
5. **Formalize the fault-injection matrix** in
   `docs/local-reliability-qa.md`: a table with one row per workflow type
   × {kill-worker mid-activity → auto-resume or terminalize (state which
   per type), cancel → prompt stop, Temporal-unreachable at start → clear
   CLI/API error, dev-server wipe → reconciler terminalizes}, each row
   naming the automated test that covers it (from P0–P5) or the manual
   step.
6. **Docs finalization.** `README.md`: CLI requires the Temporal server +
   worker (`pnpm dev` or `jobhunter worker` + `temporal server
   start-dev`); spend ceiling + default; scheduling note.
   `docs/architecture.md` + `docs/job-pipeline-architecture.md`: rewrite
   execution-model sections to describe the workflow taxonomy (the plan
   doc §Target architecture is the source). `docs/decisions.md`: ADRs —
   single execution path (supersedes the in-process runner ADR if one
   exists), spend ceiling, sync-RPC-to-workflow conversion; amend the
   JSON-RPC ADR to note dispatch is Python-native workflow starts.
   `docs/ddd-target.md`: fix the §6.5 claim that TS enqueues Temporal
   work (hint :1281) to match §5.7 (Temporal behind a Python port;
   TS speaks JSON-RPC only). `workers/automation/pyproject.toml` only if
   a dependency was added.

### Deletions

- `run_pipeline`, `_run_pipeline_inner`, the activity default wrap paths,
  the `pipeline/__init__.py` re-exports, and the CLI in-process execution
  branches. Final check:
  `grep -rn "run_pipeline\|_run_pipeline_inner" workers/automation/src/` →
  empty. (P1b already removed the stale `run_pipeline` docstring mention
  in `run_in_activity.py`; tests exercising the deleted engine are deleted
  or rewritten with it; if a stray prose mention survives in a comment,
  fixing that comment line is allowed.)

### Tests

CLI: each command starts the expected workflow type with the expected
deterministic ID (Temporal test env or a spy starter); Temporal down →
non-zero exit + doctor hint, no partial execution. Spend: recording
increments once per call on both client paths; preflight blocks at
ceiling with `budget_exceeded`; `0` = unlimited; day rollover resets.
Conversions: both new workflows run their cores, classify errors, and
appear in `workflow_run_projections`. Observability: `Stage*` fixture
comparison still byte-stable.

### Definition of Done

- [ ] Full §0.3 matrix green, plus web e2e.
- [ ] `run_pipeline` grep empty; CLI cannot execute in-process by any
      flag or fallback.
- [ ] Spend cap demonstrably blocks (test) and is visible in settings +
      health surface.
- [ ] `refresh_compensation` / `profile_import` appear in the runs UI as
      workflows (QA step).
- [ ] Fault-injection matrix landed in `docs/local-reliability-qa.md`
      with every row mapped to a test or manual step.
- [ ] All §8.6 doc updates landed, including the `ddd-target.md` §6.5
      correction.
- [ ] PR description per §0.4.

---

## 9. Cross-phase acceptance: the kill-worker demo

After P4 (and re-run after P5), the human acceptance test for the entire
effort — document results in the final PR:

1. `pnpm dev` (Temporal dev server + API + web + worker).
2. Trigger discover from the UI.
3. `kill -9` the worker process mid-discover.
4. Restart the worker (`pnpm dev` supervises; or rerun the worker).
5. **Assert:** the runs UI shows the workflow's true state within one
   reconciler tick (~15s) — never a silent stall; and discovery RESUMES
   and completes automatically (P4) with prep workflows fanning out and
   completing (P3). Zero manual retry clicks.

---

## 10. Stop conditions (repeat)

STOP and report instead of proceeding when: a named symbol/anchor is
missing; a deletion grep shows a live caller this spec says shouldn't
exist; a parity/exhaustiveness test failure cannot be resolved by
completing the registry/badge/handler set; a change appears to require
touching a file on the phase's must-NOT-touch list; any apply-path test
would contact a real external site; or `main` has drifted such that a §3
substrate item no longer exists.
