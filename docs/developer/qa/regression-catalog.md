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
| Scoring and materials | Evidence, policy version, provenance, judge output, and fabrication gates remain inspectable and honest; free-form review/prior-output text remains audit-only while retries use bounded code-owned guidance. | Deterministic fixtures, quality evals, retry prompt-boundary regressions, and inspector smoke. |
| Frontend state | URL/server/client state stay in their owning layers; every event and stage state has a handler/rendering path. | Hook/component/type tests plus parity tests. |
| Rhea/Base UI system | Tokens, cards, statuses, accessible primitive behavior, and route parity remain coherent across theme, density, and viewport. | Token/boundary tests, focused wrapper tests, route visual QA, and the browser matrix. |
| Pipeline operations | Execution topology, privacy, refresh behavior, ETA, freshness, queue, and capacity remain truthful and separately inspectable. | API/read-model tests, deterministic fixtures, invalidation/polling tests, and browser observation. |
| Provider/browser setup | Environment ownership and passive detection cannot silently become credential or browser adoption. | Worker/API boundary tests, Settings components, and explicit mutation smokes. |
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
also covers sentence-level summary aliases, exact rendered skill-group text,
mandatory coverage-edge evidence, missing or duplicate generated surfaces, and
immutable raw audit payloads before any judge call.

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

For score, rationale, materials, Apply Review, outcomes, or outreach changes,
trace each displayed claim to its source of truth. A passing UI snapshot is not
enough when the value could come from the wrong layer.

Check input evidence, deterministic/LLM transforms, validator or judge output,
persistence, projection/API shape, and rendering. Missing evidence must render
as missing—not be inferred, hidden, or replaced with reassuring copy.
Foreign keys shown in Job Detail or Artifact Detail must resolve through the
Evidence Map read model into human-readable evidence. If resolution fails, keep
the unavailable reference visible and place the raw key behind technical
details. Persisted resume comments must likewise remain visible when their
rendered-line anchor is missing.

For repeat-application decisions, trace the target and prior job through
canonical identity or an accepted duplicate link, then identify the exact
confirmed application fact. Verify the evidence fingerprint and immutable
snapshot on every block, warning, override, and consumption. Pending Gmail
suggestions, notes, dry runs, failed pre-submit attempts, and intent alone must
not appear as confirmed facts. Exercise the direct API/RPC path, standing-loop
polling, concurrent claims, and stale approval as well as the UI path; the final
worker claim is authoritative.

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
as terminal and attention totals. Stopping active discovery must refresh the
pipeline snapshot. Replacement-run setup is allowed only for an exact zero
active-work inventory, never for a positive or unavailable inventory, and it
must not dispatch until the user submits the Discover controls.

Browser reads may detect installations only to return opaque kinds and labels.
They must not disclose paths, launch, adopt, or persist a browser. Enablement is
explicit, re-resolves the selection, and fails closed when stale; manual path
entry and profile-copy consent remain separate. An environment-owned provider
route stays active and read-only while alternative routes remain editable but
inactive until environment removal plus restart.

For retry with `runAfter: true`, worker readiness precedes reset. A readiness
failure leaves state, attempts, error details, retryability, and audit evidence
unchanged and dispatches no work.
