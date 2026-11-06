# Tactical Design: Domain Invariants

These are target invariants for the Python transformation, not a statement that
the integrated implementation has already been verified.

## Sources, decisions and revisions

- Profile owns authored facts and approved words. Record source and revision
  references, preserve uncertainty, and reject stale writes instead of guessing
  which version a user intended.
- Jobs owns posting snapshots. Requirements binds qualified meanings and
  occurrences to source versions; retrieval may choose candidates but cannot
  establish semantic equivalence or novelty.
- Fit binds source-bound model judgments to recorded requirement and Profile
  revisions. Person qualification and document wording coverage are separate:
  a missing approved wording does not reduce factual fit.
- Resumes selects exactly one approved wording per achievement and retains the
  complete approved baseline, including all roles and achievements. It records
  chosen IDs and a requirement coverage manifest. See
  [tailoring](../tailoring.md).
- Source-bound semantic decisions require strict model outputs, citations,
  provenance and spend/lane preflight. Format checks, identity checks and
  arithmetic are mechanical; lexical similarity or a regex cannot decide meaning.

## Acceptance and failure

Approvals refer to exact versions and payloads. Changes to bound inputs must
invalidate the corresponding stale authority. An unrelated wording or catalog
addition can mark coverage outdated without invalidating an accepted PDF whose
selected sources and approvals remain current; changing a selected source or
revoking its approval requires renewed authority. A failed or canceled refresh
does not erase or replace the last accepted artifact. An
advisory resume coherence review has a status separate from user acceptance;
the user may explicitly accept a mechanically valid, source-bound document
with a review finding or timeout.

Applications keep exact-payload approval, durable submit intent, at-most-once
external effects and an honest ambiguous outcome when acknowledgement is lost.
Temporal retries cannot grant a fresh external authorization. Learning
milestones do not promote facts, qualification or scores. Offer terms preserve
unknowns and corrections rather than inventing values or overwriting history.

## Profile transition

The breaking cutover preserves the full Profile and supporting sources, including
attachments, confirmations, preferences, provenance and baseline. Other
JobCtrl-owned data starts fresh at the deliberate cutover. Synthetic transfer
proof is separate from recurring E2E; development and QA must not reset a real
user workspace. See [persistence](persistence.md).
