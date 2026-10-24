# Reliability & QA

Choose the smallest proof for the accepted outcome. This page selects JobCtrl's
risk and product checks. Independent code review is optional unless the user
explicitly requests it. A missing reviewer or recorded review does not block
implementation, validation, or delivery. The implementing agent may perform
the required QA; passing automated tests alone does not replace product-path
or visual verification. Explicit plans may raise the testing requirement. Never reduce security, privacy, data,
migration, release or submission proof to save time.

| Risk | Required proof |
| --- | --- |
| 0: prose/comments/format only, no contract effect | `git diff --check`; docs build for published content/links |
| 1: contained internal/tooling/instruction change | Touched checks and diff check; instruction changes include conflict/link checks |
| 2: UI/CLI/API/integration/workflow behavior | Tier 1 plus actual product-path QA; QA PASS |
| 3: privacy/security/user data/migrations/releases/submission | Applicable full risk matrix, meaningful regression fixture, operational/product proof; QA PASS |

No unresolved Blocker/High may remain, and required scenarios need observed
results. Contract-only high-risk changes require safety
checks, with product verification before first use. Major UI regressions require
a regression test or an explicit reproducible scenario.

For the job-data purge gate, the disposable workspace must contain a Candidate
Profile, Discovery settings, source registry, resume template/default, at least
one Job with registered Materials, an unregistered generated candidate, a
generated cover letter, a registered job log, `config.json`, a baseline resume
outside the generated directories, and a terminal Discover execution with a
retrying recovery manifest, search unit, pipeline step, and lifecycle events.
Seed source-quality state and a `discover` operational attempt for that run.
Seed an unrelated maintenance workflow, a `stage = operations` attempt, and
Profile/source events as preservation controls. Prove the dry run is read-only;
the confirmed command creates a readable exact-schema backup, removes the
complete Job graph and job/Discovery execution ledger, archives both registered
and unregistered generated material, compacts the database, preserves every
profile/search/template/config byte and the unrelated controls, and is
idempotent. Also reproduce the post-purge edge case with zero Jobs but the old
Discover ledger still present: the command must not report a no-op, and a second
inventory must report zero execution/history rows while the unrelated
operational attempt remains. Separately prove active work and an artifact path
outside the owned generated-data roots fail before any backup or mutation.
Never run this QA gate against a real user workspace.

Also seed provisional missing-history workflow/run pairs and prove the CLI lists
their exact IDs, refuses them, and permits the documented exact-row offline
clearance only for a matching provisional pair. Simulate the Temporal verification
precondition with disposable absent-history fixtures; never clear real rows in QA.
Verify a fresh heartbeat for the selected database refuses before backup, while
stale or other-database heartbeats do not. Inject a commit from another SQLite
connection after the backup and before deletion: the command must preserve that
write and every generated file. Seed retained pending captures, source candidates,
learning provenance/reviews/tombstones, role-feedback evidence, and a non-job
Contact Research workflow whose input retains a JobId; verify inventory, purge,
and no-op output disclose their retained counts and preserve their stored values.
Fail `VACUUM` after the deletion commit and prove the operator sees a committed,
verified purge with bundle/free-space/compaction guidance and no restore or purge
retry instruction. A separate post-commit invariant failure must retain restore
guidance.

<a id="required-commands"></a>

| Surface | Starting command / selected recipe |
| --- | --- |
| API | `corepack pnpm api:check`, focused `api:test` / `api` |
| Destructive job-data purge | `corepack pnpm api:check`; `corepack pnpm --filter @jobctrl/api exec vitest run test/job-data-purge.test.ts test/permanent-delete-v7.test.ts`; then inventory, confirmed purge, and a second inventory against a disposable exact-v14 workspace only |
| Web | `corepack pnpm web:lint`, `corepack pnpm web:check`, focused `web:test`, `web:build`; types/stories/browser when affected |
| Extension | `extension:check`, `extension:test`, `extension:build`, `extension:e2e` through Corepack |
| Worker | Locked focused Ruff/pytest; full worker suite for worker-wide changes |
| Native launcher / migrations | `JOBCTRL_MIGRATION_TEST_PYTHON="$PWD/workers/automation/.venv/bin/python" JOBCTRL_MIGRATION_TEST_NODE="$(command -v node)" corepack pnpm launcher:test`; bind the locked Python and installed Node runtimes so the cross-runtime migration checks run |
| Homebrew acquisition trust | Install the actual signed artifact through the formula with unmodified Homebrew. Inside its sandbox, strict Developer ID requirements must reject ad-hoc code. At normal-user bootstrap, rejected launcher or installer notarization must prevent installer execution; retain the installer's complete payload notarization checks before activation |
| Dense resume pagination (#907) | Locked Ruff for `workers/automation/tests/test_pdf_renderer_ports.py`; explicit `JOBCTRL_RUN_DENSE_HTML_PAGINATION_TESTS=1` locked pytest for that module; eight repeated trial cases (48 PDFs) plus four continuation-inset cases (eight PDFs), JUnit and every-page visual QA per the [owning protocol](developer/qa/regression-catalog.md#dense-html-resume-pagination-907) |
| Scripts | `node --test scripts/<name>.test.mjs` |
| Bundled capture smoke | Script suite; locked pytest for `workers/automation/tests/test_distribution_smoke_model.py`; then the real bundled-payload build through [Local Development](local-development.md#build-the-bundled-payload). Keep actual API/RPC/Temporal/worker/persistence and restart checks; only the model port uses explicit synthetic choices, recorded in smoke evidence. This does not prove semantic accuracy or provider authentication |
| Docs | `corepack pnpm docs:build`, diff check |
| Cross-stack | `corepack pnpm check`, `corepack pnpm test`, affected separate web suites |

Focused commands live in `scripts/checks.toml`. Run the selected `argv` directly,
substituting an owned artifact path for `{report_path}`. Required tests must
execute; zero tests, skipped required cases or a build alone are not product QA.

For dense HTML resume pagination, use the explicit locked commands and owned
temporary-directory recipe in the [regression catalog](developer/qa/regression-catalog.md#run-and-evidence).
That trial measures repeatability, page breaks, clipping, reading order and
layout-box correspondence with synthetic resumes through both current product
entry points on A4 and Letter. Missing Chromium/Poppler or any skipped required
case is nonpassing. Automated results require visual inspection of every
measured PDF page; pending measurements and DOM/PDF mismatches must remain
explicit. The [results protocol](developer/qa/regression-catalog.md#results-and-independent-completion)
defines severity, scope limits and the controller's completion gates. Run
`corepack pnpm docs:build` and the existing `checks.diff` recipe as well;
the implementation checkpoint does not replace these mandatory broker gates.

<a id="pick-the-right-checklist"></a>
<a id="high-risk-regression-areas"></a>

Read only the relevant [regression catalog](developer/qa/regression-catalog.md),
[browser path](developer/qa/browser-smoke.md), [frontend layer](developer/qa/frontend.md)
or [detailed matrix](developer/qa/complete-checklist.md).

<a id="pull-request-ci"></a>

[CI behavior](local-development.md#pull-request-ci) follows executable workflows;
root aggregates do not cover separate web unit/type/E2E/Storybook suites.

<a id="temporal-fault-injection-matrix"></a>
<a id="durable-execution-recovery-demo"></a>
<a id="cumulative-rheabase-ui-final-gate"></a>

Temporal fault injection, recovery and cumulative Rhea/Base UI scenarios now live
in the [detailed matrix](developer/qa/complete-checklist.md).

## Required-Bullet Coaching

Use the [focused verification commands](local-development.md#required-bullet-coaching-verification)
and [auditability invariants](developer/qa/regression-catalog.md#auditability-checks)
for changes to Required-bullet coaching. Require model-call tests that demonstrate
all findings come from the configured adapter, with no lexical fallback. Source
fixtures and form tests separately prove canonical binding, exact whitespace
acceptance, read-only inspection/rejection and individually fenced persistence.
Exercise malformed/provider failures and concurrent profile saves. Send real
TypeScript-prepared sources through the registered Python handler and saved
repository, including ECMAScript whitespace and Python-only whitespace; preserve
exact stored text and positional references. Daily/profile-lane budget denial,
provider setup/authentication and invalid-output failures must produce distinct
safe actionable messages. A failed refresh preserves the reviewed suggestions
and status; a successful complete refresh replaces the previous empty/incomplete
status. The offline demo must disable inspection, explain local installation and
provider configuration, and leave local state untouched. Isolated browser fixtures
use explicit model test doubles; additionally verify one configured provider call
with synthetic facts in an owned QA workspace before claiming live model proof.
Require observed review/QA results and final checks before publication.

## Enrichment Retry Ownership

Run `enrichment-retry-worker` and `enrichment-retry-api` from
`scripts/checks.toml`, plus `discovery-transactions` for transaction changes.
The shared synthetic SQL input must reach actual HTTP/RPC and CLI entry points.
Verify accepted content, scores, materials and approval bindings survive reset
and a failed refresh; terminal stage fields and old worker ownership must clear.
Check exhausted versus retained attempt budgets, mixed-cohort rollback, caller
transaction ownership, post-commit events, competing writers and worker pickup.
Reject malformed/foreign RPC targets and acknowledgements; canonicalize duplicate
job aliases before bulk reset. Measure cold and warm HTTP acknowledgement latency
when changing the transport boundary. Existing retry UI and event-invalidation
tests cover immediate optimistic feedback and rollback on failure.

## Discovery Transaction Recovery

Run the `discovery-transactions` recipe for preparation or enrichment transaction
changes. Seed failed and exhausted Tailor rows whose downstream stages are already
reconciled, with a scoring policy already present. Repeat the empty preparation
selection: zero changed rows must still release SQLite's writer before another
connection persists lifecycle/source events or the cached connection claims an
enrichment lease. A failed dependent update must roll back the whole reconciliation;
an inherited caller transaction must remain under that caller's control.

The recipe also separates the two waits that can surface at a lease claim. Hold a
writer on an independent connection and prove a configured SQLite busy wait fails
within the subprocess guard, then succeeds after release. In a diagnostic-only
probe, inject one connection into another thread: the default connection must
reject wrong-thread use, while an explicitly shareable connection must demonstrate
that its connection-object mutex is independent of `busy_timeout`. Run these probes
behind subprocess deadlines so a failed concurrency assertion cannot retain a test
runner thread. Confirm the real activity worker pool reuses a connection only on its
own thread, and record the production connection budgets (10 seconds for a new WAL
connection and 30 seconds for a freshly admitted exact-v14 connection). The short
fixture timeout proves mechanism and recovery; it is not a production latency bound.

Also repeat an already-claimed robots retry with a real enrichment lease, inject
retry update failures and lost comparisons, and reject superseded owners. Verify
unchanged metadata and accepted enrichment artifacts after failed persistence.
Race different owners for the same phase and attempt and require exactly one claim;
then prove a newer attempt and the terminal phase supersede it, including stale-fence
rejection.
The owned Temporal `DiscoverWorkflow` fixture runs production preparation,
lifecycle, enrichment, and terminal event persistence with connected and offline
acquisition, an already-retried blocked row, and a healthy peer whose description
must persist. Its source activity, browser/broker transport, and preparation
workflow dispatch are synthetic; it does not exercise personal Chrome, external
sources, scoring or material generation. Pair this with the applicable live
Discovery proof from the regression catalog before claiming runtime recovery.

For cancellation diagnostics, run `test_discover_reliability.py` and
`test_workflow_discovery.py` with the recovery and heartbeat checks. Exercise
both a pre-requested stop and an in-flight handoff through the real enrichment
drain; require propagation without a crash log. A genuine failure racing a
stop must still report failure. Run and replay a real Temporal source-to-terminal
enrichment handoff, retaining its completion order and checking for no error
logs. For an SDK upgrade, also replay a history generated by the previous
locked SDK, then run the full worker suite. Do not suppress exception handlers
or logger levels to pass these checks.

## Accepted Low-Fit Material Retention

Run locked `pytest tests/test_material_override_retention.py` with the
canonical single-job Tailor, material use-case, preparation fan-out and real
Temporal preparation checks. Exercise the actual writer with opposed explicit
request booleans, then repeat normal Discover target derivation. An accepted
manual generation remains approved at an unchanged automatic floor without
admitting new automatic work or changing its score; a normal generation is
suppressed. Reject string/numeric flag substitutes, another tenant or generation,
a missing score and a newly recorded hard blocker. A failed automatic replacement
must preserve the prior accepted generation and its request flag. Use two real
SQLite connections to prove a concurrent approval cannot cross the suppression
eligibility/mutation window, and inject a post-mutation failure to prove the
complete reconciliation and suppression sweep rolls back.

## Transient Provider Recovery

Run locked `pytest tests/test_provider_transient_recovery.py tests/test_provider_availability_recovery.py tests/test_saved_default_model.py tests/test_workflow_job_preparation.py`
with provider-routing, analysis and determination checks. Use owned synthetic
SDK boundaries to reproduce overload followed by overlapping requests on the
same selected model. Temporary rate, server and connection failures must not
permanently exclude that route or turn its next retry into non-retryable
unavailability. Authentication rejection, exhausted usage allowances and actual
unavailable execution still exclude their provider or model scope. Exercise the
real Score activity and preparation workflow through a failed first call and a
successful second attempt, then replay its history. Preserve bounded retry
budgets, provider/model provenance, accepted artifacts and semantic-review gates.
These tests prove failure handling; a separate configured-provider run proves
live availability.

## Agent Runtime Integration

Run the pool and actual-kit adapter checks together with existing provider
routing, failure recovery, analysis, voice and Codex isolation cases. Preserve
parallel admitted requests above the idle-cache count, fresh conversation IDs,
model/effort and named permissions, partial-usage accounting, original typed
failures, startup-publication ordering and complete cancellation cleanup.

Use a configured provider only in an owned synthetic workspace. Repeat calls
through the production LlmPort and inspect actual kit process-start/reuse
metadata and distinct conversation IDs. A reused Python adapter object is not
proof of a reused SDK process. Verify source-installed and bundled dependency
closure: a package moved into core must leave generated provider deltas, and
core-overlap rejection stays enabled. Follow
[Agent Runtime Ownership](architecture/agent-runtime.md) and the
[Auditability Checks](developer/qa/regression-catalog.md#auditability-checks).

For Codex isolation, place the owned runtime beneath a synthetic user-home
ancestor containing conflicting legacy Codex settings. Require real-kit
validation and the public app-server `config/read` to exclude that ancestor
while preserving isolated-home, workspace-local and system configuration
inspection. Verify the generated Git root without a runtime Git dependency,
concurrent initialization, failed-publication cleanup, and refusal/preservation
of symlinks, Windows junctions/reparse points, gitfiles and unfamiliar or partial metadata. Repeat real configured
provider calls through the normal typed adapter in this home-shaped workspace;
use fresh conversations and verify that process reuse and subsequent workspace
preparation remain valid. A plain temporary-root probe does not cover retained
home ancestry.

## Safe QA Data

Use uniquely owned synthetic workspaces. Never point QA at real profiles,
application artifacts or databases. Confirm worker health for worker-backed
paths. Browser launch failure and inaccessible required runtime are nonpassing.
No application submission is implied by a QA request.

## Saved Posting Availability Product QA

This is risk 3 work: evidence freshness, durable claims and reviewed submission
boundaries need verification against the exact candidate. Run the
full worker suite excluding the two explicitly environment-owned
`system_browser` cases in `test_apply_chrome_dry_run_guard.py`, cross-stack check,
API/RPC/readonly/event parity, availability web/a11y tests and web/docs builds.
The [regression catalog](developer/qa/regression-catalog.md#saved-posting-availability)
contains the complete trigger and preservation matrix.

Use an owned synthetic workspace, isolated ports, a real local Temporal worker,
real API/RPC/CLI dispatch and rendered Job Detail. External transport is the only
deterministic seam: `enrichment.availability.public_get(url)` returns a bounded
`Response(url, final_url, status, body: bytes, retry_after, content_type,
redirect_url)`; `anonymous_browser(url, fetcher=...)` is the optional browser
transport. Inject these in the private worker bootstrap, retaining production
registry, scheduling, classifier, reservations, events and persistence. Drive
active → unknown → closed → active and inspect attempt/success clocks, no-network
GET, explicit refresh, overdue/offline explanation and unchanged artifact/
approval fingerprints. Capture evidence privately; never commit workspaces,
logs, databases, materials or screenshots. Missing real runtime/browser QA is
incomplete, not a pass; deterministic external fixtures do not certify live ATS
reliability.


## Automatic Material Declines

Use owned SQLite and real Temporal fixtures to prove a canonical manual Apply
skip prevents new automatic Tailor/Cover admission. Exercise fresh selection,
frozen reservations, activity execution and a second-writer change before the
locked claim. Keep the original survivor cohort identity, release only
unstarted automatic queued ownership, preserve attempts and accepted materials,
and prove an empty filtered cohort cannot select unrelated jobs. Another
tenant, legacy apply fields, stale reason metadata and `MIN_SCORE` must not
become manual-decline authority. Clearing the canonical decline permits normal
eligibility, and an explicit foreground request retains its existing contract.

## Semantic Determinations

Use an owned synthetic workspace for these risk-tier 2/3 paths. Do not grade model
judgments or build eval sets, labeled corpora, baseline comparisons or recorded
output replay fixtures. Fake `LlmPort` tests provide opposing valid verdicts for
identical canonical inputs and prove the model controls the resulting behavior.

For every determination, exercise provider unavailability, budget denial,
malformed JSON, forbidden extra fields, unknown enums, foreign IDs, non-verbatim
quotes and mismatched values. Each failure has a distinct safe status, makes no
lexical substitute and leaves accepted artifacts current. Capture the canonical
prompt, lane and preflight order. Re-running unchanged inputs must make zero
additional calls, including concurrent requests for one fingerprint. Numeric
format coverage must include equal source/claim values before different sentence
punctuation and changed values ending in a period. Prove the actual claim
verifier preserves opposing valid model verdicts and rejects changed numbers
without replacing an accepted review. Dotted-token and malformed-number
fragments must remain invalid.

Run synthetic broad-board and company-ATS source paths with saved controls. Inspect exact provider request parameters and canonical ingestion, including a result that does not resemble the query. No separate intake model call may block or reject it. Exercise literal exclusions, limits, capture/checkpoint interruption and retry idempotency; verify provider filter support without expecting a product capability-warning view. Exercise profile import/save and explicit confirmation without
writing inferred facts into achievement evidence. Exercise actual artifact
writes, per-question isolation, empty evidence selections, user edits and PDF
source fences. Apply Review joins pins and findings by line ID and labels missing
anchors **No recorded source**. Gmail suggestions expose the outcome determination
and verbatim quote; model unavailability creates no suggestion. Compensation
shows evidence matched by persisted taxonomy codes. Affected demo capabilities
report unavailable.

For high-fit resumes, exercise all six typed persona verdicts and read actual
worker-produced metadata through the API; a persisted receipt must accompany the
persona audit. Optional voice provider or shape failures retain the already
verified candidate and record the rejected rewrite. An unresolved repeat check
parks its own candidate while another eligible candidate can be claimed. Broad-board retry drains durable unprocessed events before fetching more results, retains exact execution/lease ownership and honors cancellation and remaining new-job limits. Company ATS observations retain exact provider identity across retries. Historical captures stay preserved without an active model admission path.

CI runs the full browser interaction suite against the isolated API fixture for
explicit model results and controlled failure cases. A separate browser step
uses the production API entry and Python JSON-RPC subprocess in another owned
workspace, with profile-suggestion stubs disabled. It covers Discovery source
views and the canonical preference read, repeat-application preparation and
confirmation, and dry-run dispatch. Material workflow dispatch in this suite is
synthetic; the local live-worker suite exercises actual Temporal dispatch and
worker persistence. Opposing-verdict and failure tests exercise the production
determination services through fake `LlmPort` implementations; these tests prove
model authority and binding, without grading model decisions.

Use the exact native schema-14 boundary to test migration from every supported
source schema, stopped-runtime paired backups, source preservation, fenced
activation, recovery and concurrent-writer refusal. Preserve authored facts and
accepted artifact bytes while purging heuristic-derived determinations. Temporal
replay consumes persisted activity results and makes no model calls. Perform the
removed-symbol and TS read-time similarity searches once at PR acceptance; do not
turn source-shape searches into permanent tests.


## Saved Search Settings

Bind `JOBCTRL_MIGRATION_TEST_PYTHON` to the locked automation virtualenv's
`bin/python` and `JOBCTRL_MIGRATION_TEST_NODE` to the installed Node executable
when running `corepack pnpm launcher:test`. This exercises the Python candidate
and TypeScript reopen checks; an unavailable global Python must not silently
skip that migration evidence. Check every supported source through native
activation, API reopen, readiness failure and rollback.

Exercise native exact-v14 creation and the stopped-runtime v13-to-v14 cutover,
including source drift and candidate corruption. Preserve authored profile cells,
canonical jobs, historical envelopes, accepted files and raw pending captures.
Then use the actual Discovery path with saved targets and no interpretation
receipt: board planning is literal and makes no provider call. Fetched results ingest without an additional model pre-filter. Full-posting interpretation/scoring retain model authority and distinct failure handling. Verify the rendered settings have one checkbox per work model, no intake queue and no second approval step.
Load the profile editor's actual serialized location rows and comma-separated
work-model codes, including a location-less Remote row. Inspect their paired
board parameters. Invalid work-model controls must produce a typed planning
failure while fetching, scoring and raw source reads remain available. Native
interruption checks capture stage names from the actual composite executors and
prove recovery removes every staged candidate and SQLite sidecar.

## Smart Extract Posting Qualification

Run locked `pytest tests/test_smart_posting_intake.py` with the captured-posting recovery, Smart Extract, limits, live-browser/optional-extension, source-activity reliability and direct URL-import suites. Prove actual role/employer/location writes from the captured posting, full snapshot/enrichment convergence, canonical cross-source deduplication, literal exclusions and the new-job cap. Opposite valid model verdicts for identical sources must control location admission and specific-role acceptance. Listing pages, announcements, absent employers, incomplete descriptions and unknown location compatibility must create no Job and retain unresolved capture evidence. Confirmed mismatches retain their decision references without creating a Job. Exercise provider, budget, JSON/schema/enum, citation/value/field-binding faults, cancellation and unsafe redirects; existing accepted jobs and enrichment must survive every failed refresh. Verify identical determinations, including concurrent calls, reuse the accepted receipt without another provider call. Archived Smart Extract recovery must use the same qualification, retain source/tenant identity, preserve owner deletions and newer content, and recover interruptions without duplicate observations/events. The source activity must preserve exhausted schema/citation failure authority and retain retryability only for transient provider failures. Also run one configured-provider call with owned synthetic posting sources and inspect its actual model, effort, discovery lane and persisted source bindings. Do not build a semantic eval corpus.

## Short workflow controls under model load

For changes to local control scheduling, run locked pytest for
`workers/automation/tests/test_workflow_control_capacity.py`, the spend-budget
and material-recovery tests, then the full worker suite. Use a real independent
Temporal test server and an owned synthetic SQLite workspace. Hold every remote
activity slot with synthetic blocking work at both one and four slots. Prove
that a denied spend preflight and owner-scoped preparation cancellation finish
before that work is released, while an extra queued heavy activity stays queued
and reported remote concurrency remains unchanged. Preserve a successor owner's
stage and committed results. Replay generated old remote histories and new local
histories. Check that control database work runs off the worker event loop and
closes thread-local connections on success and failure. No provider calls or
personal workspace data belong in this regression.

## Explicit Profile Score Refresh

Run locked `pytest tests/test_score_profile_impact.py tests/test_score_batch_ownership.py tests/test_scorer.py`
and the full worker suite. Opposite valid model verdicts for identical owned
synthetic inputs must control retention versus rescoring. Exercise unchanged
cache reuse, new profile versions, provider/spend/schema/citation/binding failures,
missing historical sources and profile edits during in-flight scoring. An insignificant
profile verdict must not retain changed employer-analysis generations, requirement
weights, interpretation contents or determination IDs; failed replacement scoring
must preserve the previous accepted score and requirement report. Preserve
score/date/attempts/requirements/material bytes for retained scores and failed
refreshes. Fence review publication against replacement score and stage owners.
Use real Temporal dispatch/history replay and the actual API/Jobs UI; profile
save and API restart must make zero scoring/material dispatches, including old
undelivered/intended profile events. Show updated, unknown and reviewed-unchanged
profile states and visible model rationale. These prove model authority and
structural binding, not semantic judgment quality.
