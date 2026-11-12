# Digest

Digest owns only its review watermark and composes read-only public summaries
from Jobs, Fit, Discovery, Applications, Resumes, Companies and runtime spend
accounting. It never mutates those sources. Optional owners may be absent;
the corresponding section count is `null` and its key appears in
`unavailable` rather than implying a zero. A source read failure remains a
failure. The new-match and stale-score calculation uses a consistent Jobs/Fit
read snapshot and Fit's configured threshold.

Jobs composes the compact `DigestAttentionPanel`: only nonzero actionable
counts or accounting blockers under enabled limits appear. Absent optional summaries do
not imply healthy zero counts. A failed refresh retains the last available
summary and offers a passive retry. Deliberately disabled sources do not count
as blocked, even when their history includes failures; quarantined sources and
enabled sources with at least three consecutive failures remain actionable.
No summary read enables a source or starts work.

`GET /v1/digest` is passive. An optional `minFitScore` integer from 0 to 10
overrides the configured high-fit threshold for that read only; it never
changes saved settings. `POST /v1/digest/acknowledge` advances the
watermark monotonically, bounding a future or invalid requested time to the
server's review time. The watermark and bounded `DigestReviewed` event commit
in one transaction. Missing optional company summaries do not block the rest
of the digest. The CLI's `--min-fit-score` supplies the same read-only override;
`--acknowledge` reads a digest first, acknowledges its `generatedAt`, and returns
both the digest and acknowledgement.

Monetary availability is independent of token completeness and operation
settlement. The budget DTO carries `costStatus`, `tokenStatus`, nullable
`estimatedUsd` and explicitly partial `knownUsd`. A settled call with no reported
cost does not create attention when `dailyBudgetUsd=0`; it retains null cost.
A positive monetary cap with unavailable cost remains actionable. Running calls
are pending, while interrupted/unsettled calls remain unresolved under either
policy. `accountingBlocked`, `monetaryAccountingBlocked` and
`tokenAccountingBlockedLanes` distinguish that knowledge from policy actionability:
only unknown historical usage required by an enabled dollar or affected token
limit creates an accounting attention item. No-limit unknown history is
inspectable information; active work retains progress. No cancellation cause is
inferred and canonical action recovery remains independent. Missing tokens alone
do not invalidate known monetary totals.
