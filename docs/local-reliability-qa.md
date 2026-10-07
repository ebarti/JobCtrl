# Reliability & QA

Choose the smallest proof for the accepted outcome. This page selects JobCtrl's
risk and product checks.
Explicit plans may raise the requirement. Never reduce security, privacy, data,
migration, release or submission proof to save time.

| Risk | Required proof and independent gates |
| --- | --- |
| 0: prose/comments/format only, no contract effect | `git diff --check`; docs build for published content/links |
| 1: contained internal/tooling/instruction change | Touched checks, diff check, one independent review; instruction changes include conflict/link review |
| 2: UI/CLI/API/integration/workflow behavior | Tier 1 plus actual product-path QA; review and QA PASS |
| 3: privacy/security/user data/migrations/releases/submission | Applicable full risk matrix, meaningful regression fixture, operational/product proof; review and QA PASS |

No unresolved Blocker/High may remain, and required scenarios need observed
results. Contract-only high-risk changes require independent review and safety
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
| Dense resume pagination (#907) | Locked Ruff for `workers/automation/tests/test_pdf_renderer_ports.py`; explicit `JOBCTRL_RUN_DENSE_HTML_PAGINATION_TESTS=1` locked pytest for that module (focused selector `-k dense_resume_pagination_trial`); eight required real-browser cases, 48 measured PDFs, JUnit and every-page visual QA per the [owning protocol](developer/qa/regression-catalog.md#dense-html-resume-pagination-907) |
| Scripts | `node --test scripts/<name>.test.mjs` |
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
case is nonpassing. Automated results require independent inspection of every
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

## Safe QA Data

Use uniquely owned synthetic workspaces. Never point QA at real profiles,
application artifacts or databases. Confirm worker health for worker-backed
paths. Browser launch failure and inaccessible required runtime are nonpassing.
No application submission is implied by a QA request.

## Saved Posting Availability Product QA

This is risk 3 work: evidence freshness, durable claims and reviewed submission
boundaries need independent exact-candidate review and verification. Run the
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
additional calls, including concurrent requests for one fingerprint.

Run synthetic broad-board and company-ATS source paths with saved controls. Inspect exact provider request parameters and canonical ingestion, including a result that does not resemble the query. No separate intake model call may block or reject it. Exercise literal exclusions, limits, provider capability warnings, capture/checkpoint interruption and retry idempotency. Exercise profile import/save and explicit confirmation without
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
