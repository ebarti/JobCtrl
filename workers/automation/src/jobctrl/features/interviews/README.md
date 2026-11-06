# Interviews

This feature owns the versioned public question catalog, job-scoped generated
preparation and its history, and independent revisioned question notes. It does
not create live sessions, transcripts, mock interviewing or grading.

Preparation uses public Profile and Jobs snapshots. Current Requirements, Fit
and accepted Resume references are optional inputs. Each selected question has
its own evidence selection; an explicit empty selection remains empty and
requires a clarification gap. The retained planner, per-question draft,
claim verifier and quality judge call the configured runtime model in the
`interview` lane. Model receipts and domain determination IDs are retained and
joined on accepted reads. Profile, posting, Requirements, Fit and accepted
Resume bindings are checked before publishing an accepted replacement. A
failed replacement preserves the previous accepted generation and notes.

The HTTP surface exposes the catalog and individual questions, preparation
history, the latest accepted preparation and its provenance, note reads and
compare-and-swap writes. `interviews.generate` is the durable action behind
the job-scoped preparation request. The public `get_generation` reader lets
Applications bind an optional interview reflection to an accepted or
superseded generation without reading this feature's tables. Events carry IDs
and revisions only and commit with their owning writes.

Reviewed permanent Job deletion removes that Job's preparation, notes and
Interview-owned determination records in the same transaction. Independently
retained Learning snapshots and the shared model/accounting audit remain, as
disclosed in the deletion confirmation. A late preparation attempt checks that
the Job still exists before writing even a failed history entry.
