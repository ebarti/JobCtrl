# Digest

Digest owns only its review watermark and composes read-only public summaries
from Jobs, Fit, Discovery, Applications, Resumes, Companies and runtime spend
accounting. It never mutates those sources. Optional owners may be absent;
the corresponding section count is `null` and its key appears in
`unavailable` rather than implying a zero. A source read failure remains a
failure. The new-match and stale-score calculation uses a consistent Jobs/Fit
read snapshot and Fit's configured threshold.

`GET /v1/digest` is passive. An optional `minFitScore` integer from 0 to 10
overrides the configured high-fit threshold for that read only; it never
changes saved settings. `POST /v1/digest/acknowledge` advances the
watermark monotonically, bounding a future or invalid requested time to the
server's review time. The watermark and bounded `DigestReviewed` event commit
in one transaction. Missing optional company summaries do not block the rest
of the digest. The CLI's `--min-fit-score` supplies the same read-only override;
`--acknowledge` reads a digest first, acknowledges its `generatedAt`, and returns
both the digest and acknowledgement.
