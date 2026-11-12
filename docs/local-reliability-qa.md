# Reliability and QA

Choose the smallest real proof for the accepted outcome. The Python application
has one recurring E2E suite, started fresh for transformation #1428. Static
checks and builds remain. Unit, component, snapshot, isolated contract and
fixture-seeded internal API suites are retired. Independent review is optional
unless explicitly requested; an unavailable reviewer does not block execution.
Passing checks never substitute for a required product or operational result.

| Risk | Required proof |
| --- | --- |
| Prose, comments, formatting | Diff check and published documentation/link build when relevant |
| Internal tooling or architectural rule | Touched static checks and its real executable entry point |
| UI, CLI, API or durable behavior | Static checks plus the affected actual application journey and observed product state |
| Privacy, security, submission, stored data, cutover, release | Applicable E2E failure/concurrency proof and actual operational/platform proof; no unresolved critical failure |

A failed required runtime, missing browser or inaccessible native capability is
nonpassing. State exactly what was implemented, built, exercised and left
unverified. No unresolved Blocker/High may remain in the claimed scope.

## Commands and evidence

Run `corepack pnpm e2e` for the recurring suite. It builds the web application
once, starts real Python HTTP and worker processes with real Temporal, and
creates fresh owned workspaces. Focus with a normal Playwright filter, for
example `corepack pnpm e2e -- --grep 'approved baseline'`. There are zero test
retries. The run reports build, journey and total elapsed time; the hosted job
also measures dependency preparation. See the exact scenario and coverage
ledger in [Python application journeys](developer/qa/python-journeys.md).

Hosted Browser CI schedules that same inventory in two fixed, disjoint
Playwright shards, `--shard=1/2` and `--shard=2/2`, on separate runners. Each
invocation keeps one worker, zero retries, the existing case deadlines and the
720-second global deadline; the ordinary unsharded local command is unchanged.
Each shard builds once, owns its application/Temporal workspaces and retains
separately named evidence. Matrix fail-fast is disabled so a failed shard does
not cancel its peer. The stable **Browser / UI checks** result passes only when
both shard jobs succeed; failure, cancellation or a skipped shard cannot
qualify the complete inventory. A shard pass alone is partial proof. Record
both results and their exact candidate before claiming complete hosted coverage.

Hosted Ubuntu transport recovery may prefer only the fixed Ubuntu-listed,
operator-verified HTTPS candidate after all three completed original mirror
HTTP probes fail and a bounded candidate GET exits zero with HTTP 200.
An exit-zero original HTTP 200–399 response or an indeterminate original result
retains the originals. Incomplete/unknown results cannot authorize fallback.
Original mirrors, suites,
`Signed-By`, archive keys and signature/hash/freshness verification remain, as
do setup/test caps and required cases. HTTP reachability does not qualify archive
authenticity or package installation: actual APT verification/install and all
required test gates must pass. See the [transport recovery record](developer/qa/python-journeys.md#conditional-transport-recovery-after-1d79df1b)
for provenance and observed hosted limits.

Run the affected type, architecture, Python lint, native vet, packaging or docs
build as applicable. Invoke pnpm through Corepack and use the candidate's locked
Python environment. A direct test listing or type check is not an executed
journey. Verify the lockfiles remain unchanged after execution.

Retain exact candidate and tool versions, runner resources, command, timestamps,
results, setup/total timings and bounded synthetic logs. For UI claims, inspect
meaningful content, relevant console errors, an actual interaction and fresh
screenshots. For exported documents, inspect real bytes, selectable text and
rendered page images. For durable work, join the actual run/workflow IDs to the
canonical feature state and committed event stream.

## Safe QA data

Use only synthetic state in newly allocated, owned temporary directories. Never
point a test at a real Profile, browser profile, application, email account or
credential store. No QA instruction authorizes a real application submission,
communication, destructive reset or provider spend. Keep run dependencies shared
and bound stack concurrency, log size and artifact duplication. Cleanup must
verify ownership and stop only processes belonging to that run; a pathname,
process name, environment tag or stale PID alone does not grant kill authority.

The E2E harness allocates its own directory below the task temporary root,
checks its ownership marker and directory identity, and never adopts a
caller-selected application database. Its IPC-connected process-group leader
reserves the group identity until cleanup and tears down its own group if its
parent disconnects. Preserve unrelated services and files. Confirm owned API,
worker, Temporal, browser and helper processes have exited after a run.

## Semantic determinations

Models own meaning, equivalence, evidence support and expression coverage.
Regexes, word lists, token overlap and prose thresholds cannot replace those
judgments. A controlled external model supplies explicit source-bound choices
for the current synthetic journey; the actual gateway must perform lane/spend
preflight, schema/citation validation and persisted provenance. There is no
internal dispatch/API/domain/repository replacement, semantic fake matcher,
labeled corpus, baseline grading or recorded model-output replay.

Exercise opposing supported/unsupported determinations, invalid schema/enums,
foreign source IDs, non-verbatim spans, stale revisions, unavailable providers,
budget refusal and cancellation. Require canonical receipt/source/model/lane IDs
and failed-refresh preservation. Requirement matching supplies the complete
incoming batch and current catalog in one determination; a partial catalog,
missing decision or uncertain response cannot authorize novelty. Exercise
explicit size/refusal handling without truncation or automatic chunking.
Person qualification remains independent of approved
wording and document selection. A completed learning activity proves no skill.

Post-edit Fit refresh is manually admitted. Prove that saves, approvals, reads
and the operation's own writes make no additional model calls or queued work.
Exercise the complete-catalog impact decision, previously unsupported
requirements made relevant by new evidence, reuse of unaffected decisions,
and grouped wording preparation. Check fixed input versions and job selection,
duplicate admission, persisted call/item/deadline limits, cancellation and real
worker restart. Changes while queued or running must refuse stale work without
expanding the operation. Report recorded monetary spend separately from work
limits; ordinary lane/daily spend admission is not a guaranteed per-operation
maximum charge.

A controlled boundary proves authority and failure handling. Real SDK/provider
compatibility, authentication, a provider/model change and pre-release readiness
need their separate real boundary proof. Record unknown cost honestly.

## Source and artifact authority

For evidence, rationale, scoring, tailoring or approval defects, enforce the
[Auditability Checks](developer/qa/regression-catalog.md#auditability-checks).
Trace the visible claim to its canonical source; fix its owning feature and
reproduce the reported invariant. Readers join recorded IDs. Cosmetic masking
cannot establish a fix.

Exercise two independent saves of the same revision: exactly one may succeed.
A stale editor retains its local work and cannot overwrite accepted newer
sources. An approval binds exact text/payload, source revisions and document
bytes. Changing any reviewed input invalidates the old permission.

A failed refresh, model result, render, publication or cancellation preserves the
last accepted version and exact artifact bytes. Rejected candidates and failures
remain separate audit state. Resume composition retains every authored role and
achievement and selects exactly one current approved variant for each, with
stable weighted-coverage selection. Baseline-copy makes zero resume model calls,
including explicit review requests. Advisory coherence findings/timeouts remain
honest when the user explicitly overrides review.

## Discovery transaction recovery

Manual Jobs remains usable without Discovery or Companies. Controlled external
source pages exercise actual acquisition, identity/provenance, deduplication,
checkpointing, cancellation and retry. Race identical captures and discoveries;
accepted pages/checkpoints and Jobs writes must agree. Source policies and
literal user filters remain authoritative. A stale posting cannot publish new
requirements or fit. Failure after a canonical commit must recover without
repeating external effects or inventing source observations.

<a id="durable-execution-recovery-demo"></a>

## Durable execution recovery

Start work through the public HTTP/CLI durable action entrypoint and inspect
real Temporal acceptance. Hold an external request, cancel through the actual
API, kill the actual worker process, launch a new PID and require the original
run to terminalize or recover under its original identity. Pausing a process,
writing a heartbeat, seeding a completed row or replaying a recorded response is
not restart proof. A new healthy PID must execute subsequent real work.

Separate cancellation, graceful shutdown, worker crash, provider loss and
Temporal-history loss. Preserve accepted artifacts and explicit external
permissions. Do not retry assertions or add arbitrary sleeps to conceal a race.
Use bounded observations of actual state. Local flags and a live wrapper PID do
not prove the underlying worker or its owned descendants are healthy.

## Apply launcher ownership

Final submit is owned by the application, never an unconstrained model browser.
Exercise exact-payload rehearsal/approval, source revalidation, durable intent
before external send, at most one external attempt, valid receipts and lost
acknowledgement. A received send with no trusted acknowledgement stays Needs
verification. Restart, cancellation, stage relabel or reset cannot authorize a
second send. Manual outcomes preserve the original uncertainty and correction
history. Outreach clipboard/manual-send attestation is not automatic sending.

Installed process proof uses the actual compiled launcher, per-user native
scopes, real kernel identity and receipt lifetime, an unrelated live control,
stop/restart and retained backups. Cover root exit with surviving descendants,
TERM-ignoring payloads, verified KILL/exit, controller interruption, malformed or
linked receipts, PID reuse, inspection denial and retry after a bounded refusal.
Never fabricate an ownership flag or signal another user's process. Actual
credential stores, filesystem permissions and native launchd/Windows behavior
require the corresponding platform proof; a synthetic command cannot prove it.

<a id="schema-15-forward-upgrade"></a>

## Deliberate fresh-state cutover

The target refuses legacy application databases without mutation. The explicit
transfer preserves the full Profile, authored baseline, supporting attachments,
confirmations/preferences and provenance in a fresh target workspace and resets
other JobCtrl-owned state only at the authorized cutover. Do not run a real-user
reset during development or QA. An existing confirmation cannot be invented
from an old row shape; unknown authority stays review-required.

The full synthetic old-to-new Profile integrity proof is one-off and separate
from recurring E2E. Compare source and target facts, exact attachment bytes,
versions, confirmations, uncertainty and immutable original source. Browser
storage attachments require a distinct synthetic browser-source bundle proof.
The native lifecycle admits only the Python application identity: application
ID `0x4A435354` (`1245926228`), `user_version=1`, exact `app_metadata`, and an
authenticated `launcher/application-schema.json` declaration. Updates and
paired rollbacks stay within that target application. Legacy admission must
refuse before stopping a runtime, creating a backup/journal, replacing a selector,
or changing source data. After candidate startup fails, retain live databases
and receipts; `jobctrl stop` then `jobctrl update` continues forward. Never
restore an earlier snapshot over possible later commits automatically.

Run `node scripts/qa/native-lifecycle-e2e.mjs --python
"$PWD/workers/automation/.venv/bin/python" --temporal
"$JOBCTRL_TEMPORAL_CLI_PATH" --output-parent "$RUNNER_TEMP"` on macOS arm64.
The required native CI contexts partition that command with `--suite lifecycle`
and `--suite custody`. Lifecycle owns install/update/backup/paired rollback,
pair integrity and legacy refusal. Custody owns live execution-receipt refusal,
escaped-child cleanup and restart, failed-start forward recovery and unresolved
provider receipts. Each starts the real application in a fresh owned workspace;
omitting `--suite` runs both partitions. An unknown suite fails before setup.
The script uses compiled public installer/launcher entrypoints, real CPython,
HTTP/worker/Temporal, immutable application source, owned synthetic workspaces,
and the fixed loopback-only payload restriction. It observes coherent backup
and restart, preserved update state, both exact restored database files before
writers start, failure/resumption, malformed or changed pair refusal, unresolved
provider accounting, and environment-empty new-session TERM-ignoring child
cleanup with an unrelated process control. Its local unsigned payload does not
qualify Developer ID, notarization, stable-release retention or the actual
published predecessor. Those remain distinct required release gates; installed
release acquisition and retention must be exercised before a release claim.

## Completion

Use the [regression catalog](developer/qa/regression-catalog.md) for concrete
invariants and the [complete checklist](developer/qa/complete-checklist.md) for
product review. Record gaps in the coverage ledger. Removing a historical test
or obtaining a green build does not establish equivalent coverage, platform
safety or production readiness.
