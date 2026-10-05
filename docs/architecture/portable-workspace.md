# Portable Workspace

This proposal defines an opt-in bundle of canonical workspace data and owned
generated artifacts, with safe import. [Issue #904](https://github.com/ebarti/JobCtrl/issues/904)
owns delivery; export/import is not available.

**Read this if** you are assessing portability, preservation, or prerequisites
for a future implementation.

## Current behavior

[Back Up And Restore](../user/data-and-safety.md#back-up-and-restore) distinguishes
installed `jobctrl backup` from the source-checkout command.
[The launcher](../../launcher/internal/launcher/lifecycle.go) stops a running
runtime, snapshots `jobctrl.db` and `temporal.db` with SQLite online backup,
records hashes in `pair.json`, and restarts it. These form one restore unit;
there is no public paired-restore command. Update/rollback restores its own pairs.
The Python [CLI](../../workers/automation/src/jobctrl/cli.py) calls
[`backup_database`](../../workers/automation/src/jobctrl/database.py): `VACUUM INTO`
creates only an application-database snapshot, with manual whole-file restore.
Neither includes generated workspace files. The
[Python backup tests](../../workers/automation/tests/test_database_backup.py) and
[`TestPairedSQLiteBackupUsesOnlineBackupAndHashesBothFiles`](../../launcher/internal/launcher/lifecycle_test.go)
corroborate these distinctions as source evidence, not executed receipts here.

## Future architecture (not implemented)

### Inventory and ownership

The archive would include these canonical classes, preserving owner-defined
logical identities and provenance. [Storage](storage.md#schema-at-a-glance)
owns the table-family inventory:

- [Candidate Profile](../user/candidate-profile.md): facts, evidence, attestations,
  versions, and rendering settings; Profile-owned templates, versions/defaults,
  and Materials-owned assignments.
- Jobs and Discovery: canonical identities, source observations, duplicate decisions,
  posting snapshots, enrichment/employer evidence, settings, registry, and execution lineage.
- [Scoring](scoring.md) and [Compensation](../user/compensation-evidence.md): assessments,
  keywords, policies, corrections, source-dated benchmark facts, extrapolation
  inputs, and estimate bindings.
- Materials: accepted, rejected, and superseded generations, prompt/model fingerprints,
  selected inputs, judge/validation results, per-line provenance, audits, tailoring
  policies, and explicit-feedback learning evidence. [Materials](materials.md) owns these relationships.
- Interview preparation: generation context, catalog/question/rubric revisions and
  evidence bindings; independently revisioned notes.
  [Contacts/outreach](../user/contacts-and-outreach.md#source-of-truth-and-ownership):
  owner-recorded facts, research provenance, draft versions/gates, send attestations,
  threads, and follow-up history.
- Apply: approvals, submit intent, repeat protection/consumption/audits, outcomes,
  and linked email evidence; Operations: durable events, workflow history and
  persisted operational metrics. [Data, Events & Projections](data-events-and-projections.md)
  distinguishes these from rebuildable projections and diagnostic telemetry, which
  must not become canonical facts.

Settings-owned non-secret `config.json` values belong in the inventory under
[Storage's authority contract](storage.md#local-authority-inventory), including
budget/capacity and provider/model/source policies, without authentication state.

Owned generated text, HTML, and PDFs require Materials registrations in
`job_materials_artifacts`, as maintained by the
[Materials repository](../../workers/automation/src/jobctrl/infrastructure/materials/sqlite_repository.py).
[Apply registration](../../workers/automation/src/jobctrl/apply/launcher.py) binds
output, confirmation evidence, and shared worker logs through `job_artifacts`;
[Storage's registration flow](storage.md#files-and-registration-flow) owns the distinction.
Every included object needs producer, tenant/job/generation/run bindings where
applicable, bytes/hash, and protected transitive references. Shared files preserve
every referencing run. Incomplete closure or unknown ownership fails closed;
cleanup eligibility is not ownership.

Default exclusions are credentials, provider/browser authentication and pairing
state, unrelated/unregistered files, browser downloads, external homes, runtime
packages, checkout `.dev` data, and remote copies. Backups, legacy inputs,
quarantine, and cleanup journals require separate policy.
Directory exclusion is insufficient: canonical SQLite contains `personal_password`,
and historical prompts, logs, email, events, or Temporal payloads may contain
secrets. Verified owner-defined handling in isolated staging must exclude secrets
without falsifying evidence or breaking closure; otherwise refuse export.
Never sanitize the source in place or treat an unexamined database copy as portable.

### Validation and compatibility

An explicit bounded compatibility matrix must admit bundle/manifest versions,
producing application versions, exact database schema fingerprints, and paired
Temporal compatibility. Unsupported combinations require refusal, not automatic
migration. Preserve coherent application/Temporal authority wherever workflow
references require it; unresolved history blocks export/import.

Require a complete manifest, manifest/member hashes, required-file presence,
reference closure, and fixed entry, expanded-byte, and per-member limits;
exceeding limits refuses rather than truncates. Hashes establish consistency,
not trusted authorship. Identities must be normalized contained relative paths.
Reject traversal, absolute paths, duplicates, platform-colliding names, symlinks,
hardlinks, special files, and unsafe ancestor/root identity changes before
extraction or activation.

### Preview, consent, and preservation

Export preserves the source, including accepted artifacts. Import defaults to
a fresh isolated destination and refuses existing-state conflicts. Validation
precedes an explicit preview of compatibility, included/excluded classes,
conflicts, and destination effects. Separate activation consent binds the unchanged
bundle, preview, policy, and destination identities; expiry or concurrent change
invalidates it. Never silently merge, overwrite, resume workflows, or authorize
external actions. Failed validation preserves both workspaces and existing
destination data. Interrupted activation retains private recovery evidence,
blocks continuation pending verified recovery, and never claims success or restores
older state over newer writes.

### Readiness and mandatory proof

According to the frozen issue request, GitHub marks
[#887](https://github.com/ebarti/JobCtrl/issues/887) closed; closure proves neither
portable archive implementation nor readiness. The retention proposal's
[export/import prerequisites](../plans/sensitive-artifact-retention.md#exportimport-prerequisites-for-904)
remain unresolved: accepted versioned ownership registry, transitive closure,
complete producer inventory, all-writer maintenance fencing, and verified recovery/
activation boundaries. Its exact-v10 snapshot is historical;
[current runtime evidence](storage.md#exact-v12-runtime-and-compatible-cutovers) is exact v12.

Before implementation ships or first real-data use, require synthetic round-trip
comparison of canonical identities, evidence relationships, and artifact hashes.
Mandatory refusal fixtures cover incompatible versions/schema, tampered manifest/
members, missing files, conflicts, path/link escapes, concurrent writers, and stale
consent. Interruption, disk/permission failures, and recovery must independently
prove source/destination preservation. Applicable independent
[Tier 3 operational gates](../local-reliability-qa.md), review PASS, and QA PASS
are release conditions. This proposal performs no destructive operational QA.
