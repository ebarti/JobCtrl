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

Each slice is separately reviewable. None may exercise real user data.

### S1 — Inventory, registry, and preview

- Revalidate every writer and authority against the then-current schema.
- Implement the versioned, private, bounded ownership registry and transitive
  reference closure using synthetic fixtures.
- Ship read-only content-free preview only. Prove exact counts/bytes,
  protected/blocked reasons, policy and identity fingerprints, expiry, and
  refusal for unknown ownership or incomplete inventory.

### S2 — Maintenance, recovery, journal, and restore

- Add and integrate the all-writer maintenance barrier.
- Implement paired recovery where relevant, the state journal, same-volume
  staging, integrity verification, and conflict-safe restore on synthetic
  state.
- Prove that insufficient disk, corrupt backup, unresolved activity, and a
  changed identity cause zero mutation.

### S3 — Narrow manual diagnostics cleanup

- After owner acceptance, allow one exact diagnostic class that S1 can prove is
  disposable, inactive, unreferenced, and contained.
- Keep execution manual and per-class opt-in. Add the full failure/race matrix
  and use the actual CLI in an owned synthetic workspace.
- Required proof includes accepted preview readback and hashes, recovery and
  restore, concurrent writers, malicious absolute/traversal paths, symlink and
  hardlink substitution, mount/ancestor changes, clock changes, schema drift,
  disk-full, permission failure, partial crash at every journal transition, and
  unknown ownership. Read back final live and quarantine state independently.

### S4 — Opt-in UX and policy expiry

- Only after owner decisions and S3 evidence, add per-class policy controls,
  expiry UX, review of protected/blocked totals, and explicit confirmation.
- Scheduling remains a separate owner decision. It cannot ship by treating a
  retention age as an implicit deletion timer.

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
