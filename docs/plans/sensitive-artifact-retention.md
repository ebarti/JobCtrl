# Sensitive artifact retention and cleanup proposal

- **Status:** Proposed and unshipped. This document does not describe a
  cleanup command, timer, or deletion policy that exists today.
- **Issue:** [#887](https://github.com/ebarti/JobCtrl/issues/887)
- **Inventory snapshot:** `main` at
  `6a82c233c434e67f0a2d1c6df3db6aa68d036b75`, whose runtime database contract
  is exact v10.
- **Decision state:** The owner decisions at the end of this proposal remain
  pending. They do not block review of the design, but they do block the
  dependent implementation choices.

JobCtrl has several local authorities that can contain candidate facts,
prompts, generated documents, application evidence, and operational logs.
Those authorities currently have no unified retention or cleanup control. This
proposal defines the safety contract that must exist before a destructive
implementation is considered. The default remains read-only: there is no
implicit TTL deletion, and every eventual cleanup class must be enabled
separately and first exercised through explicit manual execution.

## Scope and boundaries

This proposal covers inventory, reference protection, read-only preview,
recovery, and a future narrow cleanup path for JobCtrl-owned local artifacts.
It does not authorize implementation or cleanup of any real workspace.

Adjacent work retains its own ownership:

- [PR #861](https://github.com/ebarti/JobCtrl/pull/861) is an open,
  source-checkout maintenance tool for purging a job aggregate. It has a
  different deletion set and purpose. Its containment, concurrency, and
  recovery findings inform this proposal, but this proposal does not adopt its
  job-deletion semantics, change that PR, or execute its purge.
- [Issue #885](https://github.com/ebarti/JobCtrl/issues/885) owns hosted-demo
  access, cookies, D1 retention, Google Analytics withdrawal, and remote
  erasure decisions. This proposal covers local telemetry only and makes no
  remote-service erasure promise.
- [Issue #904](https://github.com/ebarti/JobCtrl/issues/904) owns portable
  workspace export/import. Its prerequisites from this design are called out
  below; cleanup does not become an export mechanism.
- [Issue #886](https://github.com/ebarti/JobCtrl/issues/886) reserves database
  schema v11 for LLM spend-lane accounting. The cleanup registry schema version
  in this proposal is deliberately provisional. This proposal makes no schema
  change and does not assign it v11.

Credential reset, provider-cache reset, secure erasure, raw-evidence
redaction, and a backup-retention policy are outside v1. Provider and browser
credentials are never cleanup candidates under this proposal.

## Current source-backed ownership inventory

This table describes current ownership; its cleanup contracts are proposals,
not shipped behavior.

| Class | Current authority and producer | Current lifecycle evidence | Proposed treatment |
| --- | --- | --- | --- |
| Canonical databases | `APP_DIR/jobctrl.db` is the application authority; `APP_DIR/temporal.db` is bundled Temporal history. `APP_DIR` resolves from `JOBCTRL_DIR` or defaults to `~/.jobctrl/`. | Exact-v10 tables own tenant, job, generation, run, review, approval, repeat, outcome, event, projection, and artifact relationships. SQLite and Temporal are paired restore authority when a maintenance action touches both. | Never infer row eligibility from age alone. Traverse registered references and preserve the paired authority needed for recovery. |
| Generated Materials | `tailored_resumes/` and `cover_letters/` contain generated files; `job_materials` and `job_materials_artifacts` own generations and file metadata. | `load_current_approved` selects the maximum approved resume generation while rejected attempts remain audit history. Tailoring records selected prompt fingerprints, prompts, candidate/judge results, validation, provenance, and adversarial review. Rejected cover letters remain recorded with their validation and fabrication audit. | Protect accepted current and historic artifacts, every generation attempt, and their transitive prompt, judge, validation, provenance, and audit evidence. |
| Apply prompts, configs, logs, and diagnostics | `gen_prompt` writes `logs/prompt_*` and `.mcp-apply-*`; apply writes per-worker state under `apply-workers/`, append-only `logs/worker-N.log`, and registered files under `logs/apply-artifacts/`. | Registered apply logs point to a worker log with run metadata, but multiple runs can share that same file. The Claude CLI receives the prompt through stdin, uses `--no-session-persistence`, and still uses per-worker directories, MCP config files, and the shared worker log. | A reference from any run protects a shared file. Per-worker state and unregistered files remain blocked until an owner adapter can prove identity, inactivity, and reference closure. |
| Email outcome evidence | `application_email_evidence` in `jobctrl.db` is written by Gmail feedback ingestion. | A linked message stores provider message/thread IDs, sender, recipients, subject, snippet, link signals, up to 12,000 characters of body text, and a SHA-256 digest. Outcome suggestions and recorded outcomes can refer to this evidence. | Preserve evidence transitively from outcome, approval, repeat, and audit history. Redacting raw evidence is a separate design, not v1 cleanup. |
| Provider and browser state | `.env`, `gmail/`, `codex_home/`, `claude_home/`, `provider-packs/`, `provider-runtime/`, `browser-profiles/`, `chrome-workers/`, `apply-workers/`, and pairing/capability files live under the workspace where configured. External provider homes can also exist outside it. | These paths can contain credentials, authentication, browser state, runtime packages, caches, or in-flight execution state. Their internal ownership is not described by one JobCtrl artifact table. | Excluded. Never traverse an external home. A provider-owned cache can participate only through a provider-specific owner adapter accepted in a later design. Credential and browser-state cleanup is never implied by artifact retention. |
| Local telemetry and developer logs | Durable domain events and `worker_runtime_heartbeats` live in SQLite. Checkout-local `scripts/dev` writes `.dev/logs/`; installed worker logs live under `APP_DIR/logs/`. | Domain events and heartbeats are bounded operational records with different authority from files. `.dev/` belongs to a source checkout, not the installed user workspace, and can still contain sensitive data. | Events that support approval, outcome, submit intent, repeat protection, workflow history, or audit remain protected. Only a specifically registered, inactive, unreferenced diagnostic class can become an initial candidate. Whole-log and checkout/home globs are forbidden. |
| Remote telemetry | The Python worker can opt in to metadata-only OTLP export; hosted-demo telemetry is a separate boundary. | Local heartbeats and privacy-bounded domain events remain local. OTLP export omits prompts, completions, candidate facts, artifact paths, credentials, payloads, and exception text. Remote systems own their copies after accepted export. | A local cleanup can affect only the local authority it names. It must disclose that it cannot inspect, shorten, or prove erasure of remote retention. |
| Backups and legacy inputs | `backups/` plus legacy resume/style files are separately owned workspace content. | Backups can be the only recovery path; legacy inputs may still be source material. | Always protected by a separate policy. Cleanup never walks backup or quarantine roots recursively. |

The inventory is grounded in
[`config.py`](../../workers/automation/src/jobctrl/config.py),
[`sqlite_repository.py`](../../workers/automation/src/jobctrl/infrastructure/materials/sqlite_repository.py),
[`use_cases.py`](../../workers/automation/src/jobctrl/domain/materials/use_cases.py),
[`feedback.py`](../../workers/automation/src/jobctrl/infrastructure/gmail/feedback.py),
[`launcher.py`](../../workers/automation/src/jobctrl/apply/launcher.py),
[`claude_code_cli.py`](../../workers/automation/src/jobctrl/infrastructure/apply/claude_code_cli.py),
[`observability.md`](../architecture/observability.md), and
[`scripts/dev`](../../scripts/dev). The synthetic fixtures
[`test_apply_log_artifact_registration.py`](../../workers/automation/tests/test_apply_log_artifact_registration.py)
and
[`test_gmail_feedback.py`](../../workers/automation/tests/test_gmail_feedback.py)
corroborate registration and evidence behavior; they are source evidence, not
executed proof for this proposal.

## Proposed ownership registry

Before mutation exists, a read-only scanner must produce a versioned private
ownership registry and a content-free preview. The registry schema version is
independent from the application database version and remains **TBD** until an
implementation slice is accepted. The implementation must inspect and
revalidate the then-current database schema, table ownership, and artifact
writers. The exact-v10 inventory above cannot be treated as a promise about a
future runtime, and #886 owns the reserved v11 change.

Every registry entry must bind:

| Field | Contract |
| --- | --- |
| Registry and policy | Registry schema version, policy revision, scanner version, preview ID/version, creation time, expiry, and an integrity digest over the canonical manifest. |
| Canonical authority | Authority kind, canonical root identity, safe ancestor identities, filesystem and mount identity, or database logical identity plus exact admitted schema fingerprint. |
| Object identity | Normalized relative path under an admitted root, or database table/logical key. Absolute paths and caller-supplied arbitrary targets are not registry identities. |
| Producer and scope | Owning producer/adapter, artifact class, tenant ID where applicable, and job, generation, workflow, run, or provider references. |
| Lifecycle | Authoritative created/closed state, active/inactive proof, lifecycle source, and the policy revision used to interpret it. Filesystem `mtime` is descriptive only and never proves eligibility. |
| Integrity | Content hash for regular files or logical row-set digest for database data, byte count, and file identity including device, inode, type, link count, size, and change metadata. |
| Protection closure | Direct and transitive references from approvals, outcomes, submit intent, repeat history, generations, prompts, judges, audits, events, and shared files. |
| Decision | Exactly one of `protected`, `eligible`, or `blocked`, plus a stable reason code and bounded detail. Unknown ownership and orphan assets are always `blocked` for review. |
| Action state | Cleanup decision, decision reason, confirmation binding, and journal state. A preview alone never grants permission to mutate. |

The registry is private operational state. Its directory and files must use
owner-only permissions, its size and entry count must be bounded, and its
integrity must be checked before use. Hitting a bound fails the preview rather
than truncating totals or omitting candidates. Registry content, raw paths,
candidate facts, prompts, email text, credentials, and hashes that could act as
cross-system identifiers must not appear in domain events, telemetry, or public
exports. Events may contain only bounded class/reason counts and an opaque local
operation ID.

## Reference protection and initial eligibility

Protection is a transitive closure, not a list of favored file extensions.

1. Accepted current and historic materials pin their source files, generation
   records, prompt inputs and fingerprints, judge/validation/adversarial output,
   provenance, render evidence, and audit records.
2. Rejected generation attempts and rejected cover letters remain protected
   audit history. A later accepted generation does not make earlier evidence
   disposable.
3. Approval, recorded outcome, submit-intent, and repeat-protection histories
   pin the run, material, email, log, event, and evidence records needed to
   explain them.
4. If one physical file is shared by protected and otherwise eligible records,
   the protected reference pins the entire file. The append-only per-worker
   apply log is the current concrete example.
5. A missing, malformed, orphaned, multiply owned, or unrecognized record is
   review-only. Absence from SQLite never proves that a file is disposable.

The first mutating release may allow only an allowlisted class of **provably
disposable, inactive, unreferenced diagnostics**. Eligibility requires all of
these facts in the same unexpired preview: recognized producer and schema;
canonical contained identity; completed lifecycle; no direct or transitive
reference; accepted class policy; age derived from authoritative lifecycle
state; and unchanged file or row identity. A retention period is a lower bound
after those facts are proven, never a TTL that independently causes deletion.

Generated materials, prompts, email evidence, registered/shared apply logs,
domain events, workflow histories, credentials, browser/provider state,
external homes, backups, and unknown/orphan assets are not in the initial
eligible set. Provider-owned caches require a dedicated owner adapter that can
identify the provider, prove inactivity, state recovery behavior, and refuse
credential-bearing content.

## Canonical containment and race closure

Discovery and action must use the same fail-closed containment algorithm:

1. Start only from a compiled/registered authority and producer adapter. Reject
   absolute paths, empty paths, traversal components, alternate separators,
   unrecognized schemas, unknown ownership, caller-provided arbitrary paths,
   and whole `logs`, home, workspace, backup, or quarantine globs.
2. Open the canonical root and each ancestor without following symlinks. Record
   and validate safe ancestor directory identity, ownership, permissions,
   device, and mount identity. A symlink anywhere in the chain is a refusal.
3. Resolve descendants relative to an already opened directory handle using
   no-follow operations. Only expected regular-file types are admitted. Reject
   symlinks, hardlinks (`link count != 1`), devices, sockets, FIFOs, unexpected
   directory types, cross-device targets, bind/mount changes, and a root or
   ancestor whose identity changed.
4. At action time, recompute the canonical root, ancestor, file, database
   schema, logical row, reference-closure, hash, byte-count, lifecycle, and
   activity fingerprints. Compare every value with the confirmed preview.
   Any difference invalidates the whole plan before mutation.
5. Keep the maintenance barrier described below through staging, database
   commit, and verification. Directory-handle-relative operations and identity
   comparisons close path substitution between the final check and move.

This contract makes preview/action races explicit. A cleanup action never
auto-replays an expired or stale plan, and it never silently drops a changed
item from an already confirmed plan.

## Read-only preview and explicit confirmation

Preview is always the default operation and has no mutation capability. Its
human-readable output is content-free and reports:

- exact `protected`, `eligible`, and `blocked` counts and bytes, by admitted
  artifact class and stable reason code;
- exact totals and whether every registered authority was completely scanned;
- registry, policy, database-schema, canonical-root, reference-closure, and
  inventory identity fingerprints;
- preview version, creation time, expiry, and an opaque preview ID; and
- the checks that block action, including unknown ownership, activity,
  insufficient recovery space, or incomplete history.

The detailed private manifest can map opaque IDs to relative/logical identities
for local review, but the normal preview must not print artifact contents,
prompts, email fields, profile data, credentials, external paths, or remote
payloads.

A future action requires the operator to select each eligible class explicitly
and enter an exact confirmation bound to the preview ID and version, policy
revision, expiry, identity fingerprints, and complete unchanged candidate set.
Confirmation does not survive expiry, policy change, restart, schema change,
new activity, or any identity/reference change. V1 is manual-only. Scheduling
requires a later owner decision and cannot weaken per-class opt-in or the
preview binding.

## All-writer maintenance barrier

`BEGIN IMMEDIATE` can exclude competing SQLite writers; it cannot freeze file
writers, provider subprocesses, a second process using a different database,
or Temporal activity. A safe action therefore requires an all-writer
maintenance barrier owned by the workspace:

1. Atomically enter a workspace maintenance generation that every TypeScript,
   Python, Temporal, apply/browser worker, supervisor, and future writer checks
   before starting or committing work. Refuse new work and drain admitted work.
2. Independently verify process and listener state, current worker heartbeat
   identity and activity slots, API/database path agreement, Temporal
   task-queue/workflow activity, apply/browser subprocesses, and open workflow
   or recovery histories. Do not infer quiescence from one missing or stale
   signal.
3. Refuse action when a listener/process remains, a heartbeat is current,
   activity cannot be resolved, histories are revivable or incomplete, a
   workflow authority is unavailable, or different checks disagree.
4. Acquire the database write lock only after the broader barrier holds, then
   revalidate preview state. Keep the barrier until the action is verified or a
   recovery result is durably recorded.

The implementation must define how every existing writer honors the barrier
before any mutating cleanup class ships. A partial writer inventory is a
read-only implementation.

## Recovery-first quarantine and journal

Mutation uses a private same-volume quarantine and an append-only, fsync'd
journal. Same-volume file moves provide an atomic staging primitive; quarantine
is recovery state, not proof of deletion. The operation state machine is:

```text
planned -> prepared -> staged -> committed -> verified
```

- `planned` binds the unexpired preview, selected classes, policy, identities,
  and explicit confirmation.
- `prepared` records the maintenance barrier, complete revalidation, available
  space, a readable and integrity-checked backup, and a recovery rehearsal for
  the affected authorities. If disk is insufficient or a backup is corrupt,
  the operation performs zero mutation.
- `staged` moves admitted files to same-volume quarantine by their verified
  identities and records original/quarantine locations and hashes. Database
  changes have not committed yet.
- `committed` records the atomic database change and, when relevant, the
  coordinated SQLite plus Temporal restore point. The journal is durable before
  the barrier can be released.
- `verified` independently reads the live authorities, reference closure,
  counts, hashes, containment, and integrity; only then does the action report
  success.

A failure before `committed` restores staged files and leaves the live database
unchanged. A failure during or after commit retains the journal, quarantine,
and backups, blocks further cleanup, and enters explicit recovery; it never
claims an all-or-nothing result that was not observed. Recovery restores
SQLite and Temporal as a pair whenever the action could affect their shared
authority.

Restore must never overwrite newer state. Under a fresh maintenance barrier it
may restore to the original identity only when the destination is absent and
the expected pre/post identities prove that no newer object is present. A
conflict restores into a separate private recovery location and requires manual
reconciliation. Recovery verifies hashes and database integrity before changing
operation state.

Quarantine expiry is a separate, per-class explicit opt-in with its own preview
and confirmation. Removing quarantine bytes makes no secure-erasure claim.
Backups remain protected under a separately accepted policy, and scanners must
exclude backup, journal, and quarantine roots so cleanup cannot recursively
consume its own recovery state.

## Failure and privacy behavior

- Unknown ownership, schema drift, truncated inventory, stale preview,
  unresolved activity, containment ambiguity, identity drift, permission
  errors, inadequate disk, and backup/integrity failure all fail closed.
- A partial commit is reported as such, with recovery artifacts retained and
  further cleanup blocked. No stale plan is auto-replayed after restart.
- Manifests and journals contain no artifact bodies. Any unavoidable local
  identity metadata is private, bounded, and excluded from events, telemetry,
  support bundles, and default export.
- Local deletion does not retract prior OTLP, hosted-demo, Gmail, analytics,
  provider, or other remote copies. The preview names those boundaries without
  promising remote erasure.

## Export/import prerequisites for #904

Portable export/import depends on a stable accepted registry schema and the
same transitive reference-closure algorithm. Export must preserve canonical
logical identities and integrity without converting cleanup eligibility into
ownership. Import must validate schema compatibility, containment, manifest
integrity, and reference closure before presenting a conflict preview.

Credentials, provider/browser authentication state, remote copies, cleanup
manifests/journals, and quarantine are excluded from export by default.
Backups require their own explicit policy. Export and import must preserve both
the source workspace and existing destination data until a separately
confirmed activation succeeds.

## Future implementation slices and evidence

Each slice is separately reviewable. None may exercise real user data. The
branch names below are proposed, not created. If an earlier slice remains
unmerged, the work is one sequential stack: S1 starts from the then-current
`main`, and each later branch starts from and targets its predecessor. If an
earlier slice has merged, the next slice first synchronizes with the new
`main`. Every slice must re-read the then-current schema and source/writer
inventory; exact v10 describes this proposal's snapshot and makes no promise
that a future implementation is v11.

| Slice | Proposed branch and base | Dependency |
| --- | --- | --- |
| S1 | `feat/retention-registry-preview`, from then-current `main` | Accepted design and a fresh source/schema inventory. |
| S2 | `feat/retention-maintenance-recovery`, from S1 while S1 is unmerged | S1 registry, identity, preview, and reference-closure contracts. |
| S3 | `feat/retention-manual-diagnostics-cleanup`, from S2 while S2 is unmerged | S1 + S2, plus owner acceptance of one exact diagnostic class and its retention/grace inputs. |
| S4 | `feat/retention-policy-ux`, from S3 while S3 is unmerged | Accepted S3 evidence and all policy/UX decisions needed by the selected controls. |

### Provisional module and interface boundary

All new paths and interfaces in this section are provisional until their slice
is accepted. Python retention code stays under one package,
`workers/automation/src/jobctrl/retention/`:

- `registry.py` defines typed owner adapters, canonical authority/object
  identities, lifecycle facts, and `build_registry(...)`.
- `references.py` computes the protected transitive closure; `manifest.py`
  writes and verifies the private bounded versioned manifest.
- `preview.py` produces the content-free exact-count/byte/fingerprint result.
  Preview consumes a registry snapshot and cannot expose a mutation method.
- `decision.py` binds selected classes and exact confirmation to one unexpired,
  unchanged preview and policy revision.
- `maintenance.py` is a typed client of the launcher-owned maintenance
  protocol. It never implements a lock, generation counter, or fallback
  barrier.
- `quarantine.py`, `journal.py`, and `restore.py` implement staging, the
  `planned -> prepared -> staged -> committed -> verified` state machine, and
  conflict-safe restore only after a valid maintenance lease is supplied.

`workers/automation/src/jobctrl/cli.py` will expose a provisional Typer group
with three public interfaces:

- `jobctrl retention preview [--class CLASS]` is read-only. It may run without
  the Go launcher or a maintenance barrier, but active, changing, or unknown
  state remains blocked and its manifest cannot authorize later mutation after
  expiry or change.
- `jobctrl retention cleanup --preview-id ID --class CLASS --confirm TEXT` is
  manual and mutating. It requires the exact preview/state/policy-bound
  confirmation and a launcher-issued maintenance lease before preparation,
  staging, commit, or verification.
- `jobctrl retention restore --operation-id ID --confirm TEXT` is manual and
  mutating. It requires its own exact confirmation, a fresh launcher-issued
  lease, identity revalidation, and conflict-safe destination checks.

The registry/manifest API is private Python data, not a TypeScript API or a
domain-event payload. CLI output is the content-free preview or a bounded
operation receipt. `cleanup` accepts only opaque IDs already present in a
verified manifest; it accepts no arbitrary path, database query, or ad hoc
object list.

### Maintenance-generation ownership and writer protocol

The Go process authority in `launcher/internal/launcher/` owns acquisition and
release of a workspace maintenance barrier. S2 proposes
`maintenance.go` plus platform/process tests there. That authority stores an
owner-only durable state containing a monotonically increasing workspace
maintenance generation, mode, workspace-root fingerprint, operation/lease ID,
and issue/expiry times. A generation is never reused after release or crash.
The launcher returns a typed `MaintenanceLease` for the exact workspace,
generation, operation, and preview fingerprint over a private inherited control
channel; it does not pass the token in argv, ordinary environment, events, or
logs.

Every registered writer in `apps/api/src`, Python, Temporal activities, and
apply/browser subprocess publishing paths must participate in the same
launcher-owned protocol:

1. A writer registers its producer and observed generation before work. The
   barrier changes the generation and refuses new writers while draining.
2. Existing writers must validate and hold the shared writer lease at the
   actual SQLite commit or atomic file-publish/rename point, not only when work
   starts. A generation change causes transaction rollback or leaves the
   temporary file unpublished.
3. Each runtime reports bounded typed quiescence for its active transactions,
   Temporal activities/workflows, subprocesses, and pending file publications.
   The launcher independently checks process/listener, heartbeat, Temporal,
   database-path, and producer-registration evidence before issuing the
   exclusive maintenance lease.
4. An unsupported/unregistered producer, missing commit/publish fence,
   unavailable runtime check, or disagreement between signals prevents the
   lease and therefore prevents mutation.

The Python CLI requests typed operations and consumes the lease; it must not
create a second barrier with `BEGIN IMMEDIATE`, a PID file, or a Python-only
lock. In a source-only environment where the Go launcher or shared-generation
protocol is unavailable, `retention preview` may still run read-only, while
`cleanup` and `restore` fail with a typed
`maintenance_authority_unavailable` result before any preparation or mutation.
There is no direct-Python fallback.

### S1 — Inventory, registry, and preview

- **Owns:** the provisional Python `registry`, `references`, `manifest`, and
  `preview` modules, the read-only Typer command, and synthetic fixtures under
  `workers/automation/tests/retention/`. It makes no launcher, API, writer, or
  database-schema change.
- **Boundary:** revalidate every owner, writer, table, file producer, and exact
  schema before defining the registry version. The manifest remains private;
  only the content-free `PreviewResult` crosses the CLI boundary.
- **Acceptance scenarios:** complete and schema-mismatched inventories;
  direct/transitive approval, outcome, submit-intent, repeat, generation,
  prompt, judge, audit, and shared-file reference closure; exact
  protected/eligible/blocked counts and bytes; stable content/row hashes and
  authority fingerprints; expiry and clock rollback/advance; absolute and
  traversal input; symlink, hardlink, ancestor/mount identity change; unknown
  ownership; corrupt or oversized manifest; and state change between scans.
- **Planned checks:**
  `uv --project workers/automation run --locked --all-extras pytest -q workers/automation/tests/retention/test_registry.py workers/automation/tests/retention/test_preview_cli.py`,
  `corepack pnpm python:lint`, `git diff --check`, and
  `corepack pnpm docs:build`. Tests assert exact counts, bytes, hashes,
  fingerprints, decisions, and zero writes.

### S2 — Maintenance, recovery, journal, and restore

- **Owns:** provisional launcher maintenance authority and tests under
  `launcher/internal/launcher/`; the Python `maintenance`, `quarantine`,
  `journal`, and `restore` modules; the mutating restore Typer command;
  writer-fence integrations in `apps/api/src`, Python/Temporal repositories and
  activities, and apply/file publication paths; and synthetic cross-runtime
  fixtures. The Go launcher is the only acquisition/release owner.
- **Boundary:** expose the typed durable-generation/lease protocol described
  above. Preview stays barrier-free and read-only. Preparation, stage, commit,
  verification, and restore all require the exclusive lease and full
  action-time revalidation.
- **Acceptance scenarios:** concurrent TypeScript/Python database writers;
  writer arrival during drain; file publisher before and at rename; active and
  stale process/listener/heartbeat combinations; Temporal running, revivable,
  unresolved, unavailable, and quiescent histories; apply/browser subprocess
  activity; mismatched database/root identity; unsupported writer; source-only
  Python mutation attempt; insufficient disk; permission denial; missing or
  corrupt backup; journal write/fsync failure; crash/restart at every journal
  transition; paired SQLite/Temporal restore; restore conflict with newer
  state; and successful independent post-restore hashes/integrity.
- **Planned checks:** `corepack pnpm launcher:test`,
  `corepack pnpm --filter @jobctrl/api test -- retention-maintenance.test.ts`,
  and
  `uv --project workers/automation run --locked --all-extras pytest -q workers/automation/tests/retention/test_maintenance.py workers/automation/tests/retention/test_recovery.py`.
  The matrix must observe zero mutation for every refused precondition and
  durable recovery artifacts for every simulated partial commit.

### S3 — Narrow manual diagnostics cleanup

- **Owns:** provisional `decision.py` and `cleanup.py` inside the same Python
  retention package, the mutating Typer command, one owner-approved diagnostic
  adapter, and an actual-CLI synthetic proof harness. It depends on the
  implemented behavior of S1 and S2 and adds no second maintenance mechanism.
- **Boundary:** permit exactly one diagnostic class that S1 proves disposable,
  inactive, unreferenced, and contained. Execution is manual and per-class.
  Before requesting the S2 lease, require the operator's exact CLI confirmation
  bound to the preview ID/version, expiry, policy revision, complete candidate
  set, and unchanged identity/reference/activity fingerprints. Expired or
  changed preview/state is rejected before staging; confirmation cannot be
  deferred to S4.
- **Acceptance scenarios:** invoke the actual public CLI in an owned synthetic
  workspace; read back the accepted preview and confirmation binding; verify
  pre/post live, journal, quarantine, backup, and restored hashes; reject
  missing/wrong/expired confirmation and every unchanged-state mismatch;
  exercise mutation and restore, a concurrent writer, path traversal, symlink,
  hardlink, mount/ancestor change, clock change, schema drift, disk-full,
  permission failure, unknown ownership, and partial crash at each state-machine
  transition. Read back the final live and quarantine state independently.
- **Planned checks:** an S3-owned
  `scripts/retention-synthetic-proof.sh` runs `jobctrl retention preview`,
  `jobctrl retention cleanup`, and `jobctrl retention restore` against a fresh
  temporary `JOBCTRL_DIR`, then verifies exact JSON receipts and hashes. Run it
  alongside
  `uv --project workers/automation run --locked --all-extras pytest -q workers/automation/tests/retention/test_cleanup_cli.py`,
  `corepack pnpm launcher:test`, `corepack pnpm api:test`, and the S1/S2 suites.
  The harness contains synthetic facts only and never targets a real workspace.

### S4 — Opt-in UX and policy expiry

- **Owns:** owner-approved policy storage/API under `apps/api/src`, UX under
  `apps/web`, and expiry/scheduling adapters that call the existing S1-S3
  interfaces. It does not replace the S3 CLI confirmation or S2 barrier.
- **Boundary:** depends on accepted decisions for eligible classes, retention
  and quarantine grace, manual-first versus scheduling, and backup policy. UX
  may present the existing exact confirmation contract. Scheduling is a
  separate opt-in and can only produce a fresh preview for confirmation; age
  never becomes an implicit deletion trigger.
- **Acceptance scenarios:** owner-approved per-class policy create/update and
  audit; protected/eligible/blocked preview display; policy-revision
  invalidation; opt-in scheduling disabled by default; preview expiry and
  quarantine grace boundaries; clock change; and remote-boundary disclosure.
  Credentials, provider caches, browser authentication, raw-evidence redaction,
  and remote erasure remain excluded.
- **Planned checks:** focused API contract tests, web interaction/accessibility
  tests, policy-expiry/scheduling clock-boundary tests, `corepack pnpm api:check`,
  `corepack pnpm web:check`, and `corepack pnpm docs:build`, followed by the S3
  actual-CLI proof to show UX/policy changes did not weaken confirmation or the
  barrier.

The checked-in apply-log and Gmail fixtures are inputs to S1 fixture design,
not substitutes for S3 CLI proof. Production-safe verification means an owned,
synthetic workspace with no provider/browser credentials, no external homes,
and no real profile, application, or email content.

## Pending owner decisions

These decisions remain open without blocking publication of this proposal:

1. Which diagnostic classes, if any, can enter the initial allowlist.
2. Per-class retention periods and a separate quarantine grace period.
3. Whether the product remains manual-first permanently or may later offer
   scheduling after S3; no schedule is part of v1.
4. Raw evidence redaction is excluded from v1; decide whether it needs its own
   later evidence-preserving design.
5. Credential reset and provider-cache reset are excluded; decide whether any
   provider owner adapter should be designed separately.
6. Backup retention and expiry are excluded; decide a separate policy before
   any backup or quarantine expiry implementation.
