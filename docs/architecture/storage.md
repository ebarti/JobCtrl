# Storage

The source candidate stores application tables and DBOS system tables together
in a private PostgreSQL database for each workspace. Feature-owned files, native
credentials and provider runtime state retain their separate owners. This
source change does not establish what an installed release contains.

## Workspace transition

The supported upgrade source is the current Python SQLite workspace. An explicit
import takes a consistent SQLite snapshot and stages a PostgreSQL destination;
it verifies row counts, content digests, identities and file bindings before
activation. The source and owned artifacts are preserved. Drain outstanding
work before migration; uncertain external effects and provider charges remain
unsettled, and predecessor Temporal histories are not replayed. See the
[migration plan](../plans/2026-11-25-postgres-dbos.md) for its acceptance gates.

## Ownership

| Store | Owner and contents |
| --- | --- |
| `app_metadata`, `app_feature_schemas` | Runtime identity and feature schema admission. |
| `app_events` | Committed bounded invalidations and identifiers; no private document or credential payloads. |
| `app_settings` | Revisioned non-secret runtime/provider policy settings. |
| `app_action_runs`, `app_worker_heartbeats` | Durable application admission/results/cancellation and current worker observations. |
| `app_model_calls` | Source-bound model attempt receipts, provenance, output and accounting status. |
| Feature-owned tables | Profile, Jobs, Requirements, Fit, Resumes, Discovery, Companies, Contacts, Outreach, Applications, Interviews, Learning, Digest, Compensation and Offers own their schemas and canonical writes. |
| DBOS system tables | Durable workflow execution, queue and recovery state in the workspace database. |
| Feature-owned files | Profile sources and resume render/export artifacts, bound to the owning feature's immutable records. |
| Native OS credential store | Allowlisted provider secrets; never ordinary settings or backup JSON. |
| `extension-capability-token` | Private loopback/extension capability; rotation invalidates prior pairing. |
| `.action-custody/*.lock` | Private per-run process custody; persistent names prevent lock-file replacement races. OS descriptor lifetime owns the lock. |
| Provider-owned auth/runtime directories | Isolated authentication and SDK runtime state; never source evidence or resume authority. |

A feature reads another owner's data through a public snapshot/guard, never
through private SQL. Source/version guards may share the caller's connection so
publication cannot race a source change. Jobs permanent deletion invokes
explicit registered owner deletion ports in the same transaction. An owner can
refuse deletion when durable external intent still requires preservation.

The redesign's Profile recovery restores a requested removed role or achievement
from retained Profile versions into the latest document under a version fence;
it does not replace the whole current document. Pending wording revisions retain
their exact earlier text/decision snapshots. Fit owns separate immutable
user-association revisions with soft remove/restore and original meaning/source/
optional-wording pins. Those intent records remain unassessed and stale when
their inputs change. Neither recovery nor association storage rewrites accepted
resume artifacts.

## Transactions, events and accepted artifacts

The shared transaction context commits on success and rolls back on failure.
Contested admissions, revisions and budget reservations require database
serialization. Domain acceptance and DBOS dispatch share a transaction. Feature adapters own domain repositories,
optimistic version predicates and exact accepted-artifact rules.

`EventStore.append` requires an existing write transaction. SSE and Activity read
only committed rows; rollback cannot publish an invalidation for a write that
never happened. The stream supports integer replay cursors and closes with
`workspace_changed` if the workspace database identity changes.

A failed refresh records its failed/blocked attempt separately from the last
accepted artifact. Readers join recorded requirement/source/approval/receipt IDs.
They do not recalculate semantic decisions from words or reconstruct canonical
state from telemetry. Resume acceptance, external approval and provider receipts
remain distinct records with distinct authority.

## Sensitive material and accounting

Database data and backups, generated documents, source attachments, logs and
provider profiles are private. They must not enter commits, issue comments or
public verification artifacts. Synthetic QA evidence records behavior and
identifiers without real applicant data.

Model accounting distinguishes a provider that was definitely never dispatched
from one whose execution/usage is uncertain. A failed preflight has no invented
zero usage. Interrupted execution retains its receipt and can block further
budgeted work until accounting is resolved. Reported and configured estimated
costs are labeled separately; unknown values remain unknown. Native update or
rollback must preserve unresolved ledgers instead of erasing them with an older
snapshot.

Finite monetary caps require provider-reported cost or an explicit exact-model
pricing quote before dispatch. Quotes retain their source and revision with the
receipt. Setting a monetary cap to zero disables that cap; it does not fabricate
unknown costs or disable lane/token admission.
