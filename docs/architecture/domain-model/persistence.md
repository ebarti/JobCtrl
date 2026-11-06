# Feature Persistence and Transition

The Python target retains local SQLite. Features own their schemas, repositories,
transactions and revision predicates. The composition root provides shared
infrastructure, not a cross-feature generic business repository. This is a
contract for work in progress; the integrated cutover and transfer are not yet
verified.

## Canonical ownership

Each feature declares and initializes its own tables. Cross-feature reads use
public services and recorded IDs rather than sibling-private tables. A mutation
and its bounded invalidation event share a transaction; an event is visible to
SSE only after commit. Optimistic concurrency and source-revision checks reject
stale publications. The foundation contract describes SQLite connection,
transaction and schema identity mechanics.

Profile owns full career facts, evidence, source attachments, saved
confirmations, preferences, authored baseline and approved wording. Requirements
owns requirement identities and occurrences; Fit owns qualification and wording
coverage relations; Resumes owns selected IDs, documents, reviews and
acceptance. These records retain relevant source revisions and provenance.
Failures must not destroy an existing accepted artifact or its export bytes.

## Breaking fresh-state transition

At deliberate cutover, the full Profile and supporting sources transfer to a
fresh target workspace; all other JobCtrl-owned data starts fresh. Unknown
confirmation provenance remains unknown rather than being fabricated. A
synthetic one-off transfer proof must cover identity, attachments, authored
content and confirmation history separately from the recurring E2E suite.
Development and QA do not reset real user data. No actual user reset, release
or deployment is authorized by the transformation plan.

The old data remains subject to the user's chosen backup and transition process;
this document does not claim an implemented migration, rollback or verified
transfer. See the [accepted plan](../../plans/2026-11-06-python-transformation.md)
and [storage reference](../storage.md) for integration status.
