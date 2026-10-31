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

For native shutdown, exercise actual per-user launchd scopes with owned synthetic
writers and an environment-empty child that forks, calls `setsid()` and execs a
platform binary. Reap all original parents and prove status/stop still find and
terminate it. Preserve another instance as a control. Cover root-first clean
shutdown and foreground cancellation, TERM-ignoring leftovers, actual KILL and
exit verification, ordinary restart, direct paired-backup readback and CLI
execution. Never use names or environment tags as complete kill authority.

Interrupt the stop process after durable stopped proof and after receipt
retirement, then repeat cleanup through fresh processes. Cover PID reuse across
inspection retries, admission versus stop, controller EOF, metadata/retirement
failures, linked/malformed receipts and exact-byte preservation on refusal.
Legacy untracked registries must remain ownership-unverified, even after a known
group exits; modern scoped cleanup supplies the positive restart/backup proof.
No required case may pass by fabricating an ownership flag or a real user's
coalition ID. Kernel boot identity binds receipt lifetime and is not a reboot
admission requirement. Use no real user workspace or process.

The bundled native smoke must preserve network isolation across launchd: run its
native control process outside Seatbelt and select the fixed internal
`JOBCTRL_EXECUTION_QA_SANDBOX=loopback-only-v1` restriction at the authenticated
job helper. Verify the actual compiled native-to-CPython dispatch can connect to
loopback and receives `EPERM` on a reserved non-loopback TCP permission probe,
with no application bytes sent. Keep direct extracted-runtime sandbox probes
and signed/notarized first-use qualification distinct.

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

For provider SQLite ownership changes, prove overlapping clients and threads
share one temporary store per process and credential home, and the last fully
closed client removes it. Exercise a real owned subprocess exit without cleanup:
the next acquisition must reclaim only that unlocked matching store. Active
leases, other homes, unfamiliar versions/files, linked ownership records and
redirected roots must survive. Use the pinned native SDK to verify shared state,
independent ephemeral thread IDs, temporary logs and the credential-read fence;
then observe disk use and model availability through the real UI flow. Never
delete the original provider history as an automatic repair.

For native release retention, use independently resolved runtime and workspace
roots, including a custom `JOBCTRL_DIR`. Promote at least three signed synthetic
stable releases, then verify the oldest referenced release is eligible for an
explicit rollback and that the restored database pair matches its recorded
backup identity and bytes. Check active, controller, journal, prior, live-instance,
non-stable and foreign preservation while an unreferenced owned stable release
is pruned. Exercise an independent installed Apply through the owned selector,
then verify the selection lock is released after the controller and helper exit.
If its exact completion is unavailable, a separate workspace's promotion must
preserve every candidate release. An exact completed receipt permits ordinary
cleanup. Cover absent supervisor registry, malformed or foreign receipts,
changed evidence during collection, same-boot live or unavailable coalition,
and a prior-boot completed receipt; leave unrelated release contents untouched.
Missing, malformed, linked or unreadable managed ownership must stop
cleanup before any release is deleted. A missing `pair.json` in a native `pair-`
directory also stops cleanup; a non-prefixed directory verified to have no
`pair.json` is treated as unrelated and watched. Malformed, unreadable or linked
`pair.json` in any immediate backup subdirectory stops cleanup. Use owned
synthetic workspaces and do not publish or deploy a release. Exercise the
explicit rollback entry point with a renamed pair and verify its recorded
identity and restored bytes. Separately,
place metadata in a different directory with a local pair ID and exercise the
rollback reader and `restorePair` to verify the pair binding and bytes. In both
cases, retention must keep the referenced release while pruning a separate
unreferenced release. Preserve unrelated directories without metadata, and refuse
if a pair appears in one after collection or its aliased target is linked or
replaced. Replace the release
root after store open and during promotion; replace an entry at its atomic claim
and the root after claim. Verify foreign bytes and successor paths are preserved,
including a restore collision, and repeat the anchored filesystem cases on macOS
and Linux. Add extra files and empty directories at the release root and inside
the signed payload, modify an authenticated file, and replace a child during
its claim. Preserve those contents while a separate intact, unreferenced signed
release is pruned. Add a foreign file during cleanup and verify it survives.
Check that an unauthenticated higher-sequence receipt cannot displace an intact
signed prior release. Alter a signed candidate's receipt and policy to claim an
unrecorded higher sequence and verify it cannot displace the recorded prior;
an older recorded unreferenced release must still be pruned. Check that a live
instance with an inconsistent build,
payload path or manifest digest stops cleanup. Swap a paired-backup directory
after listing and after collection, including swap-and-restore, and verify the
pair identity and bytes and its referenced release remain intact. Also create a
new backup authority after collection and verify cleanup refuses it.
Unsupported platforms must refuse pruning.

For shared source and installed workspaces, create a real source-purpose native
execution receipt in an owned synthetic workspace. Check that its live source
registry and later verified completion permit pruning a separate unreferenced
release while preserving the release and exact bytes of its paired backup.
Repeat with an authentic completed prior execution receipt in the same
workspace; missing or malformed prior completion must stop cleanup. If the
native controller does not publish completion, verify refusal and preserve the
fixture. Separately exercise completed, missing, malformed, active and
unavailable prior authorities with explicitly synthetic receipt and counter
fixtures; these do not prove a native completion occurred.
Exercise the native stop writer with synthetic source receipts: its completion
may predate the stopped registry, and verification may occur on a later boot.
Refuse a same-boot prior scope whose completion records a different verification
boot, whether its synthetic scope counter reports zero or an absent coalition.
Retain source-purpose separation from Apply and refuse a same-boot scope that
is live or cannot be verified as stopped.
Malformed, changed, missing or mismatched execution evidence, an unverified
registry, or a changed checkout launcher must stop cleanup before deleting the
control release. Preserve source-migration backups for both current and legacy
Temporal paths. A controlled process-census seam does not prove host process
cleanup or permission to signal a real process.

<a id="required-commands"></a>

| Surface | Starting command / selected recipe |
| --- | --- |
| API | `corepack pnpm api:check`, focused `api:test` / `api` |
| Destructive job-data purge | `corepack pnpm api:check`; `corepack pnpm --filter @jobctrl/api exec vitest run test/job-data-purge.test.ts test/permanent-delete-v7.test.ts`; then inventory, confirmed purge, and a second inventory against a disposable exact-v15 workspace only |
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

For event-stream reconciliation, use an owned synthetic workspace with the
actual API and a Linux-isolated browser. Read before a delayed or failed first
connection, commit a change before the server chooses its cursor, and verify
the mounted view refreshes without another event. Hold an initial read across
open, and exercise reconnect, tenant switches, a pending profile save and a
dirty template draft. For an Apply run, use the production Apply repository to
write a durable saga event before open and another while the detail refresh is
held; prove both remain visible after the response. Check the safe stream
summary, interruption/replay ordering, and that unrelated tenant/job rows are
not attributed to the run.

For form-save reconciliation, delay synthetic contact creation and model-policy
saves and verify their editing controls pause until acknowledgement. Delay a
contact edit, type newer changes, and check the reopened-session fence. For Offer terms
and decisions, edit after dispatch, publish another revision or return 409,
and prove the visible draft and the next explicitly reviewed expected IDs. For
templates, exercise a dirty or pending draft through a newer publication, a
failed latest-version read and a failed set-default after a successful version
save. Use independent SQLite writers to hold the write lock across a competing
publication and prove the stale version request cannot commit. Verify a stale
default request is refused and the saved version remains selectable.
For provider setup, delay fake API responses with synthetic placeholder inputs;
check later key, path and mode edits through a save and provider-status refresh.
After a failed save, make the credentials read report a failed inspection or
fail outright. Verify the real settings panel keeps the newer draft and the
specific save failure, blocks guided writes, and restores editing after a
successful read. For both providers, retain the distinct incomplete-recovery
and unverified-ownership removal errors through the same transition.
For CapSolver, delay synthetic save and removal responses, enter a newer value,
and verify it remains unsaved and can be deliberately submitted after either
success or failure. Verify an environment-managed removal reports its actual
cause rather than an unsupported platform.
No real credential store, account or provider connection is used.

For Apply browser ownership, run locked pytest for
`tests/test_apply_browser_ownership.py`, `tests/test_apply_chrome_dry_run_guard.py`,
`tests/test_apply_origin_policy.py` and `tests/test_browser_capabilities.py`.
Use real owned listener/client and process-group controls through browser launch,
failed launch, cancellation, scoped cleanup, import and Python exit. Preserve
unrelated occupants, reject changed handle/PID/session authority, prove the
POSIX reaping fence and actual owned descendant exit, and retain failed records
when root or session exit cannot be verified. Reap an actual root while its
listener child remains live, both in the original group and a separate group
of the original session; cleanup must retain the owner, preserve the child and
unrelated control, and still clean another selected owner. Also terminate a live
root while its child survives in another group. After the child exits itself,
a read-only empty-session retry may settle the retained record without a signal.
Use a real fork/session-handoff relay to create a successor after enumeration
while the inspected ancestor leaves the original session. Repeat the race
across both otherwise-empty observations: changing PID/generation inventories
must retain the owner while the successor remains in the original session.
Only enumeration/timing seams may be controlled; PID, session and generation
metadata must come from the actual owned processes.
For the installed native fence, repeat the real Apply/Temporal peer and
same-job retry while a separately owned coalition creates processes during the
session census. Verify the unrelated coalition survives and no false refusal
occurs. Fork a real successor during an otherwise-empty session observation and
require the native task-start count to detect the handoff. Verify a detached
child keeps the native scope's active-task count nonzero until actual exit;
an unavailable or invalid counter must fall back to conservative verification.
Inject a process-inspection permission failure and verify the activity reports
only its bounded cause without paths or process details. Unknown failures, a
colliding worker exit status, and missing or changed receipt evidence must not
be classified as that cause or certify cleanup.
For browser and agent handles, exercise cooperative TERM, TERM-ignoring group
escalation after the grace period, including a leader that exits during grace,
and a leader already exited before cleanup with a surviving child. Keep an
independent peer alive and require the last case to retain custody without
signalling an unverified group.
Inject an agent cleanup timeout through the real registry entry point and prove
retention, selected-peer cleanup, unselected-owner preservation and exact retry.
Model Windows kernel-handle termination followed by explicit unverified
descendant completion and retained ownership, without claiming native Windows
Apply qualification. The optional real-browser smoke remains
separate; these ownership trials must not open a user browser or application.

## Schema-15 Forward Upgrade

Use owned synthetic workspaces and the locked migration Python/Node runtimes.
Verify the new installer's signed descriptor, complete payload inventory,
protocol-2-only range, schema-14-to-15 declaration, channel sequence/revocation
policy and original source selection under both lifecycle locks. The actual
archived protocol-1 controller must refuse the target before backup or journal
creation. Authenticate the predecessor only as historical evidence, including
a revoked predecessor; never execute it. Refuse a revoked target, altered
receipt/declaration, changed selection generation, unknown source schema,
regressed live schema and unknown legacy handoff without destructive repair.

Exercise all nine durable boundaries from metadata verification through policy
finalization. Before selector replacement, recovery uses the authenticated new
installer entry; the archived protocol-1 public binary must refuse the new
journal without changing it. After replacement, use public `jobctrl update`.
Do not substitute the new in-process `Run` implementation with an old executable
pathname as proof of the archived binary or installer process boundary. Commit independent
profile, resume, search and Temporal WAL changes after interruption and candidate
start, fail readiness, and retry repeatedly. Check current paired snapshots,
original/recovery backup IDs, exact selection and policy, preserved app inode,
protected rows and external config/resume bytes. Finalization after the active
selection write must complete without restarting a healthy candidate. Cover
same-schema updates and rollback target-start failure separately. Revoke a
candidate with live owned writers: pure cleanup must stop them without executing
the payload or changing the journal/selection, while update and startup still
refuse the revoked target. Initial
installation/adoption must refuse schema 14 without original predecessor
metadata and permit preserving an exact-v15 reinstall after cleanup.

Use an actual owned detached writer to prove normal cleanup, timeout-only
termination, waited exit and restart before migration. Preserve another instance
as a control; inspection/cleanup failure blocks backup and database mutation.
Reboot is last-resort troubleshooting for actual failure, not upgrade admission.

Before first publication/use, qualify the actual signed/notarized installer and
payload through curl and unmodified Homebrew, using the archived installed
selector, real startup and failed-readiness recovery, the same preservation
matrix, and explicit cross-protocol rollback refusal. Source merge and synthetic
fixtures alone do not qualify an installed upgrade. These interruption tests do
not claim physical power-loss durability or protection against hostile disk
control.

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
connection and 30 seconds for a freshly admitted exact-v15 connection). The short
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

Run `tests/test_claude_terminal_failure.py` with those checks. Through the
actual kit and synthetic SDK messages, reject nonempty failed terminal results
for plain, structured, analysis and voice calls, as well as a failed kit schema
result. Check retained usage and failed generation spans, distinct execution,
schema and budget outcomes, bounded retries, and preservation of the previous
accepted artifact and verified voice-stage candidate. Do not use real provider
credentials or model responses for these cases.
Also fail stream iteration and runtime cleanup after an observed terminal
receipt: account its usage once, retain its primary failure, and record the
post-terminal failure separately. A pre-terminal transport failure keeps its
existing provider-failure behavior.
Cancel each caller after receipt, including repeated cancellation and a late
cleanup failure; require cancellation to propagate, terminal usage to reach the
owned spend ledger once, and previously accepted material to remain intact.
Also cover a receipt observed during cancellation cleanup and cancellation
before any receipt.

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

For credential mutation ownership, use only injected fake native runners and
owned temporary lock paths and workspaces. Exercise overlapping batches and
single-key updates through the API and independent processes, including exact
rollback, incomplete recovery, bounded contention, timed-out helpers, and an
owner killed both before helper registration and while its helper is alive.
Exercise PID reuse, exact live birth identity, verified exit and denied process
inspection; never signal an unrelated process. Verify responses and lock
records contain no submitted values. Never probe a
real native credential store for this regression.

## Gmail Feedback Scan Contract

Run locked worker Ruff and pytest for `test_gmail_feedback_client_contract.py`,
`test_gmail_feedback.py`, `test_gmail_feedback_scan_handler.py`,
`test_gmail_connector.py`, `test_gmail_feedback_v10_anchors.py`,
`test_gmail_feedback_privacy.py`, and `test_llm_spans.py`; run API
type checking and `gmail-feedback-integration.test.ts` with the locked worker
interpreter. The latter exercises the HTTP route and registered Python RPC with
the real Gmail client, synthetic model decisions, and an in-memory HTTP
transport. Use only an owned synthetic database and mailbox responses.

Verify empty anchors issue no search; recipient, time and result limits hold;
opposite source-bound decisions control linking; duplicate messages remain
deduplicated; and provider/model failures preserve existing evidence and expose
safe typed codes without mail content. This does not establish live Gmail
coverage or model accuracy.
Inspect HTTP logs and exported spans with content tracing both enabled and
disabled. Gmail recipients, query strings and message bodies must remain
absent; unrelated concurrent HTTP and model tracing must retain their normal
behavior, and local determination receipts must remain source-bound.

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

For contact research, follow the
[inference and acquisition checks](developer/qa/regression-catalog.md#auditability-checks),
including a synthetic source-bound model decision, its receipt, failure and
accepted-review preservation through the worker, API and review surface.

For legacy evidence confirmation preservation/recovery, follow the dedicated
[Auditability Checks](developer/qa/regression-catalog.md#auditability-checks).
Use exact-schema owned originals and native paired backup metadata, preserve
saved confirmation history and accepted files, and require visible structural
review before canonical source admission. Verify stale/conflicting recovery and
private-event filtering through the real local CLI/API/UI; never use private
user safety copies or infer author authority from a row shape.

Use an owned synthetic workspace for these risk-tier 2/3 paths. Do not grade model
judgments or build eval sets, labeled corpora, baseline comparisons or recorded
output replay fixtures. Fake `LlmPort` tests provide opposing valid verdicts for
identical canonical inputs and prove the model controls the resulting behavior.

For compact factual citations, run locked
`pytest tests/test_claim_review_response.py tests/test_artifact_determinations.py`
and the full worker suite, then API receipt-version checks. Prove full-source
references and explicit spans retain every canonical model decision, source ID,
quote and declared literal value. Reject unknown references, wrong-line and
wrong-source citations, changed numbers, forbidden fields and oversized/empty
whole-source selections within the existing correction budget. Exercise
request-local concurrent decoding, caller mutation, stale-input cache fencing,
failed-refresh preservation and known historical receipts. Grounded excerpt
references must preserve their original source ID and exact Unicode bytes, add
no line permissions, reject foreign/non-verbatim excerpts before provider work,
and leave oversized excerpts on the explicit-span path. Use the configured
provider with synthetic facts, then measure the unchanged model/effort and
required review policy through the real UI; smaller JSON alone is not speed proof.

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

For parallel resume repairs, pair a valid factual rejection with a completed
quality finding in owned file-backed SQLite. The next generator request must
carry both canonical determination IDs and finding sets. Retained speculative
quality feedback is repair data only: it cannot approve a rejected draft, replace
a fresh verdict for changed inputs or expand the canonical retry evidence
catalogue. A failed refresh preserves the accepted artifact and bytes.

For high-fit resumes, exercise all six typed persona verdicts and read actual
worker-produced metadata through the API; a persisted receipt must accompany the
persona audit. New requests must bound nested diagnostics without omitting any
persona or overriding a failed model verdict; historical accepted wider
receipts remain readable in full. Optional voice provider or shape failures retain the already
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

Use the exact native schema-15 boundary to test migration from every supported
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

Exercise native exact-v15 creation and the stopped-runtime v13-to-v14-to-v15 cutover,
including source drift and candidate corruption. Preserve authored profile cells,
canonical jobs, historical envelopes, accepted files and raw pending captures.
Then use the actual Discovery path with saved targets and no interpretation
receipt: board planning is literal and makes no provider call. Fetched results ingest without an additional model pre-filter. Full-posting interpretation/scoring retain model authority and distinct failure handling. Verify the rendered settings have one checkbox per work model, no intake queue and no second approval step.
Load the profile editor's actual serialized location rows and comma-separated
work-model codes, including a location-less Remote row. Inspect their paired
board parameters. Invalid work-model controls must produce a typed planning
failure while fetching, scoring and raw source reads remain available. Native
interruption checks capture stage names from the actual composite executors.
Verify cleanup of owned intermediate candidates and sidecars after successful
execution or a failed prepublication build; after an ambiguous activation or
preservation refusal, retain the live pair, recovery journal and evidence needed
to inspect the interrupted transition.

## Reviewed Permanent Deletion

Use an owned exact-v15 synthetic workspace and independent SQLite writers. Read
the actual Jobs list, select removed items, then restore, unhide or restore and
re-delete with identical timestamps before preparation and after confirmation.
The complete selected graph and accepted material references must survive each
refusal. Unrelated heartbeat commits must not invalidate an unchanged selection.
Prove all-matching selection freezes the originally observed cohort, including
newly matching jobs, more than 5,000 matches and overlapping filters; no
truncation or widening is permitted. Exercise mixed cohorts, aliases, foreign
tenants, expired/replayed receipts, cancellation, lost acknowledgement, and a
writer held across the locked final comparison. Existing explicitly authorized
active-job deletion and purge must retain their behavior. Verify the rendered
Jobs flow and browser-local demo separately. Run the full worker and native
migration suites with every supported source version, independent source-drift
and old-controller compatibility checks before claiming an installed upgrade.
For exact-v14, exercise the authenticated bound activation with a live WAL
reader, a write between receipt validation and the SQLite lock, DDL and commit
faults, and process interruption at the schema/commit boundaries. Verify the
live inode and protected profile, resume, settings, search and external file
bytes remain intact; reader/source drift must refuse safely.
Commit synthetic writes to both databases after the paired backup and after
activation, then inject candidate failure and interruption. Verify repeated
ordinary and revoked recovery attempts retain the live files and resumable
journal, and do not restart a predecessor or replace newer commits. Include
same-schema updates and explicit rollback's target-start failure separately.

## Smart Extract Posting Qualification

Run locked `pytest tests/test_smart_posting_intake.py tests/test_captured_posting_recovery.py tests/test_archived_smart_posting_temporal.py` with the Smart Extract, limits, live-browser/optional-extension, source-activity reliability and direct URL-import suites. Prove actual role/employer/location writes from the captured posting, full snapshot/enrichment convergence, canonical cross-source deduplication, literal exclusions and the new-job cap. Opposite valid model verdicts for identical sources must control location admission and specific-role acceptance. Listing pages, announcements, absent employers, incomplete descriptions and unknown location compatibility must create no Job and retain unresolved capture evidence. Confirmed mismatches retain their decision references without creating a Job. Exercise provider, budget, JSON/schema/enum, citation/value/field-binding faults, cancellation and unsafe redirects; existing accepted jobs and enrichment must survive every failed refresh. Verify identical determinations, including concurrent calls, reuse the accepted receipt without another provider call. Archived Smart Extract recovery must use the same qualification, retain source/tenant identity, preserve owner deletions and newer content, and recover interruptions without duplicate observations/events. Interrupt before each original discovery event and require all three original canonical facts on retry, without another observation. Distinct content-duplicate candidates must each retain an idempotent event. Legacy initial-owner observations must refuse missing-original recovery before provider setup even when the first event is absent. Fail the actual snapshot use case after canonical insertion, then retry through the real Temporal source activity and replay its history. Require exact saved-capture convergence without another page/model call, including an exhausted last admission slot. Inject failures after snapshot, enrichment, accepted-progress and completion writes; all partial publication writes must roll back together while the canonical owner and retry evidence remain. Independently commit newer metadata, observations, accepted enrichment/snapshots, stage ownership and deletion; stale recovery must preserve them. Check source attempt supersession, cancellation before publication/acknowledgement, damaged capture/determination receipts and private prepared-event suppression. The source activity must preserve exhausted schema/citation failure authority and retain retryability only for transient provider failures. Also run one configured-provider call with owned synthetic posting sources and inspect its actual model, effort, discovery lane and persisted source bindings. Do not build a semantic eval corpus.

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

## Blocking activity generation capacity

Use synthetic events and fake providers to hold three retired blocking-pool
generations. Verify the next submission receives the retryable capacity refusal,
each cancellation remains owned by its original call, and accepted results are
preserved. Releasing one call must not free a generation while a peer in that
pool still runs; releasing the last call must permit a healthy next submission.
Check the actual worker heartbeat, Operations aggregation and view for refusing,
accepting, old/malformed/unknown and stale-worker states. Free Temporal slots
must not imply blocking admission, and no status may claim an unfinished thread
or its child processes stopped. Use no live provider or personal workspace.
While all three stage generations remain held, exercise the real short budget,
owner-scoped cancellation and workflow lifecycle activities in a synthetic
workspace. They must finish before any stage call is released, preserve a
successor owner, and close thread-local connections. Separately fill both
control calls, prove excess work is refused without rotating or releasing
either call, then release one and prove admission and shutdown recover.

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

## Concurrent Preparation Recovery

Run `test_automatic_preparation.py`, `test_automatic_preparation_overlap.py`,
and `test_automatic_preparation_temporal_qa.py` with affected ownership and
politeness tests. Real Temporal cases must complete peer Enrich and Score while
per-job and automatic batch activities remain open, then replay every history.
Require unchanged accepted artifacts and owners, shared capacity under the saved
internal limit, frozen reservation reuse under independent writers, and exact
recorded-run settlement without a preflight retry loop. Exercise the fail-closed
cases in the [regression catalog](developer/qa/regression-catalog.md). Worker-wide
scheduler changes also require the full worker suite and a restarted runtime
using the tested candidate.


## Apply Launcher Ownership

Run locked `pytest tests/test_apply_launcher_ownership.py tests/test_apply_crash_custody.py tests/test_apply_dashboard_isolation.py`
with Apply batch, launcher, saga, approval/submit-intent and agent-adapter suites,
including `tests/test_apply_execution.py`.
Use real Temporal and owned synthetic HOME, workspace and SQLite state; control
only browser/agent/external ports. Admit two distinct-job activities together,
then complete, fail, cancel and abandon one while its peer retains its event,
process, accepted files, canonical owner and result. Replay every history.

Reuse dashboard worker numbers and exercise multiple internal workers advancing
concurrently: each allocation must return its own fresh identity/port pair.
A prior attempt's namespace is never reset. Scope reset, totals, rendering and
events to exact resource IDs, including the empty selection; event floods and
startup cannot evict a peer's history. Cleanup failure must fence the next claim,
preserve the real listener/registry/files and settle other selected workers.
Overlap two worker cleanups and prove the independent worker can claim, finish,
and retain its result before the other's refusal. Exercise both dry-run modes.
Block one selected worker's cleanup guard during an interrupt and verify an
available peer is still cleaned under the same deadline. Concurrent cleanup of
the same handle remains serialized. Race adapter publication against interrupt
and reject stale/replacement handles; retain a standalone unpublished child for
retry if its own cleanup fails. Reject a concurrent agent attempt before it can
write or remove the active owner's MCP configuration; keep that file reservation
until the owner's final unlink and verify the next attempt can then start.
Exercise transient incomplete or changing unscoped session censuses beyond the
former one-second window, and require the same two complete matching empty
inventories before continuing. With many selected browser and agent handles,
persistent uncertainty and blocked ownership locks must share a bounded cleanup
pass rather than multiply a per-handle wait. Bound per-process census reads and
exercise the real interrupt entry with its run lock blocked before the snapshot
and before recording the result. If the pass deadline expires during TERM grace,
retain the handle without early force. Hold an owned pipe open during cleanup,
then release it and verify a bounded retry retires the handle. Distinguish
confirmed process-inspection denial from signal denial without exposing paths.
Include real Temporal cancellation with the production drain bound, a progressing
peer, stale/reused identities and births registered after an earlier worker was
checked or for a newly added worker; no unverified handle may be signalled or
retired.

For installed native mode, kill a real owner before spawn, between spawn and
local handle publication, after publication and after root exit. The selected
old custody remains unknown without actual native authority; a different-job
successor is admitted and preserves the old files/process. Administrative stage
reset must not transfer the same job. Inject stale result, aggregate/artifact,
lock-release and bus publications
and prove none mutate a successor. A synchronous no-created-child spawn failure
must abort its intent without permanently gating future unrelated work. Retained
on-disk custody must not retain closed routing entries or reaped-root pipe FDs.

Run native `TestNativeCompletionRecoversApplyCustodyAfterEscapedWriter` with the
locked checkout Python. Authenticate the actual coalition/receipt, lose the
Python owner, retain a TERM-ignoring setsid writer, refuse only selected old
custody retirement and admit an unrelated peer. Real native stop must verify
KILL/exit, persist exact completion and preserve another instance. A fresh native
execution consumes that proof and retires only the selected journal. Assert final
cleanup of both owned scopes. Include the `execution-completions-durable`
interruption boundary, metadata refusal tests and full native race/vet checks.
No fabricated ownership flag, guessed PID, missing-receipt waiver or reboot
prerequisite stands in for observed authority. Use no real account/application.

Qualify the fixed installed module through actual Temporal and an authenticated
local native payload whose only controlled seams are browser/model/network and
synthetic profile ports. Keep actual activity dispatch, fixed module, canonical
claims, saga, per-Apply coalition, selected cleanup and native completion. Admit
two distinct jobs together; complete/fail/cancel each while the peer retains its
process, files, owner and accepted result; replay histories. Rehearse the same job
again after actual per-run cleanup, preserving fresh IDs and directories. Spawn
a TERM-ignoring setsid writer from the adopted executable’s readiness preflight
to prove the scope begins before that probe. Cover success, command error,
cancellation, controller death, interrupted completion publication/retirement and
final cleanup of every owned scope. These observed native-authority requirements
apply to installed mode. Qualify source-checkout Apply against the best-effort
requirements below, without adding a mandatory native helper or compiler dependency.

Filesystem and network isolation alone do not isolate macOS Keychain. Real
Chromium QA must run on an isolated hosted runner/container unless Keychain
access is demonstrably isolated. Never reset or alter the user's Keychain to
make a test pass. Use synthetic CDP/WebSocket stubs for host ownership and stale
endpoint tests; a temporary HOME/profile does not establish Keychain isolation.

For source-checkout Apply, prove normally finished born-resource attempts can
retry after their exact tracked children have exited, with fresh files and
RunIds and `full_tree_verified: false`. Active owners, known cleanup failures and
ambiguous submit intent must remain protected. This best-effort source behavior
requires no native helper build, Go toolchain or Linux guardian.
Exercise a source worker carrying an authenticated fleet scope: an Apply claim
must use source lifetime recovery, while a forged, mismatched or bundled source
scope refuses. A fleet receipt must never qualify as per-Apply completion. Keep
the dedicated installed Apply receipt and completion checks as separate controls.
On Darwin, the synthetic source-controller composition probe carries its real
fleet receipt into Python and checks active-owner fencing, peer isolation,
same-boot retry and exact tracked-child cleanup under the loopback-only QA scope.
Exercise unrelated host churn while the authenticated source coalition's
task-start counter fences the owned session; verify exact child identity and
pre/post-reap session observations. Changed counters, surviving session members,
PID reuse and incomplete scope scans must refuse cleanup. Unavailable counters
must retain the strict unscoped fallback rather than treating the fleet receipt
as per-Apply completion.

Source hard-crash QA uses real owned Python processes and a retained private
control pipe for every deliberately surviving child. Confirm close-on-exec owner
FD non-inheritance even with `close_fds=False`, actual owner exit, normal
untargeted batch recovery, unchanged old files and stale-RunId write refusal.
Stop the test child through its exact pipe and observe exit; never infer signal
authority from an orphan numeric PID. Keep active/abandoned owner leases busy,
refuse missing/linked/replaced lock files and persist known cleanup failure
before release. A generic stage reset must not waive exact submit-intent ambiguity.

## Public Demo Edge Persistence And Privacy

Run `corepack pnpm demo-edge:check` and `corepack pnpm demo-edge:test` using the
local synthetic D1 fixture. Exercise each required grant write and each optional
telemetry admission or insertion failure, checking response cookies and retained
identity/event rows. A successful initial grant whose response is lost can be
retried without cookies: the operation counter remains deduplicated, but a new
identity pair is created while the first remains until expiry. A repeat carrying
the granted cookies refreshes the existing pair instead.

Exercise expired, exactly expired and future controls in all seven retention
tables, a repeated sweep, and rollback when the scheduled batch fails after
earlier deletes. Capture and validate the closed custom log fields on success,
failure and limited-denial paths. Source configuration declares an hourly cron
and disables invocation logs and traces; local tests do not establish deployed
schedule timing, account logging settings, physical retention or backup behavior.
