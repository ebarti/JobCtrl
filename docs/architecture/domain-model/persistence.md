# Feature Persistence and Transition

The source candidate uses local PostgreSQL, with DBOS system tables in the workspace database. Features own their schemas, repositories,
transactions and revision predicates. The composition root provides shared
infrastructure, not a cross-feature generic business repository. This is a
contract for work in progress; the integrated cutover and transfer are not yet
verified.

## Canonical ownership

Each feature declares and initializes its own tables. Cross-feature reads use
public services and recorded IDs rather than sibling-private tables. A mutation
and its bounded invalidation event share a transaction; an event is visible to
SSE only after commit. Optimistic concurrency and source-revision checks reject
stale publications. The foundation contract describes PostgreSQL connection,
transaction and schema identity mechanics.

Profile owns full career facts, evidence, source attachments, saved
confirmations, preferences, authored baseline and approved wording. Requirements
owns requirement identities and occurrences; Fit owns qualification and wording
coverage relations; Resumes owns selected IDs, documents, reviews and
acceptance. These records retain relevant source revisions and provenance.
Failures must not destroy an existing accepted artifact or its export bytes.

## Workspace transition

The supported transition imports the current Python SQLite workspace into a
staged PostgreSQL database, preserving canonical feature data, generated keys,
artifacts and completed action records. Validation precedes activation and the
source remains available. Outstanding work must be drained or explicitly
reconciled; predecessor Temporal histories are retained, not replayed. A rollback
before later writes differs from restoration after later writes. Development and
QA use owned synthetic workspaces and do not reset real user data. See the
[migration plan](../../plans/2026-11-25-postgres-dbos.md) and
[storage reference](../storage.md) for the contract and proof gates.
