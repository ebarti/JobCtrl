# Fit capability inventory

Fit owns person qualification, source-bound evidence support, eligibility,
deterministic scores and corrections, and the relation between a qualified
requirement and an exact approved wording variant. Profile owns factual sources,
wording text and every wording approval. Requirements owns canonical meanings
and job occurrences. Resumes owns selection and document acceptance.
Only recorded authored facts/baseline and explicitly confirmed evidence enter
qualification. Pending, review-required, rejected and deferred sources remain
available for Profile inspection without becoming factual authority.

| Capability | Canonical target entry point | Retention and boundary |
| --- | --- | --- |
| Requirement-level person qualification | `FitService.assess_job` / `fit.assess` | Strict model judgment over the complete qualified meaning and versioned factual sources; never inferred from a resume or word overlap. |
| Reuse across jobs | `Qualification.resolve` | Keyed by Profile, canonical requirement revision and factual source inventory. A new job occurrence changes priorities without repeating the qualification. |
| Factual edits | `fit.profile-impact` | A source-bound model judges each changed requirement assessment. Unchanged support keeps its original semantic receipt, with a separate current-source revalidation receipt. Affected support receives a new qualification. |
| Capability score | `domain.calculate_score` | Retains `requirement-fit-v2-scoped`: direct 1, strong .85, transferable .6, must-have multiplier 1.25, four-decimal contributions, half-up 1–10 mapping and capability-blocker cap 4. Eligibility/logistics/employer conditions contribute no points. |
| Confidence and eligibility | `get_job_fit` | Persisted model verdicts and cited reasons remain separate from points. Compensation/location/work-model preferences are warning categories. Unknowns remain unknown. |
| Live minimum-fit selection | `minimum_fit_score`, `get_job_fit.selection` | Reads the shared versioned setting without recomputing a score. A score must be current and unblocked to be ready. |
| User score correction and calibration history | `correct_score` / `fit.correct` | Adds a new immutable score version and correction anchor while retaining the computed score, source report and stale state. One correction does not silently change arithmetic or qualification. |
| User qualification correction | `correct_requirement` | Requires the exact assessment, factual Profile version, canonical requirement revision and literal current evidence. Invalidates only scores/relations that used the superseded assessment. |
| Approved expression coverage | `refresh_coverage`, `coverage_for` | Separate strict model decisions join canonical requirement revision, accepted qualification, achievement, exact variant revision, approval and source versions. Unsupported facts never receive positive coverage. |
| Grounded wording preparation | Profile public `request_authoring` | A supported gap requests one proposal under the owning achievement. Origin identity excludes the job; rejected/deferred requests are retained and reused. Only Profile's explicit user action can approve. |
| Baseline/off composition | `assess_job(prepare_coverage=False)` | Person qualification may run; no wording-coverage or authoring call runs. `prepare_wording=False` alone suppresses proposals while still preparing exact coverage. |
| Evidence reverse links | `evidence_map` | Public source/requirement/score/determination IDs, exact source excerpts, recorded qualification gaps, exact variant/source relations and current/stale usage. Absent coverage stays `not_recorded`; only complete recorded noncoverage or no approved variant establishes a wording gap. |
| Keyword filters | `keywords` | Latest accepted model-supplied labels, NFKC/whitespace normalization and casefold lookup keys; normalization never decides support. |
| Jobs and Digest composition | `query_summaries`, `summary_for_jobs`, `digest_summary` | Bounded bulk score/assessment queries and public Requirements binding reads share the caller's snapshot. Stored high-fit values and stale state remain distinct. Cutoffs compare UTC instants at millisecond precision, including equal cutoffs. |
| Durable restart | `fit_operation_receipts` | Score mutation and the operation receipt commit together. A retry returns its own accepted revision without repeating model work. Interrupted expression preparation is reported honestly and can be explicitly retried. |
| Permanent Job deletion | `delete_job_data` | Removes job score versions, correction anchors and operation results in the Jobs transaction; reusable person/requirement intelligence remains independent of jobs. |

`bootstrap.build_feature` is used by the sole Python application. HTTP, CLI and
durable execution call the same service. The feature reads no sibling private
tables. Every canonical mutation and its bounded invalidation event commit in
one SQLite transaction. Bootstrap constructs the SQLite adapter and injects the
feature-owned `FitStorePort`; application code handles no SQL or transactions.
Typed read sessions hide connection details and share a caller's transaction
when supplied. Atomic publication methods own the final source, cancellation and
assessment/version checks together with the record, operation receipt and event.
Inference never holds the writer lock.

The old opaque dimension-score compatibility path is superseded by the accepted
qualified requirement catalog. Missing or incoherent weighted requirements
cannot create a replacement score; there is no lexical or legacy fallback.
Old scoring modules are outside this target composition and their final removal
belongs to the coordinated runtime cutover.

## Public HTTP and events

`GET /v1/jobs/{job_id}/fit`, `/fit/history`, and `/fit/coverage` are read-only.
`POST /v1/jobs/{job_id}/fit/assess` requires `expected_revision` and accepts
`profile_id`, `force`, `prepare_coverage`, and `prepare_wording`.
`POST /v1/jobs/{job_id}/fit/correct` requires the exact revision, score and
rationale. `POST /v1/jobs/{job_id}/fit/coverage/refresh` explicitly prepares
coverage/proposals. `POST /v1/fit/requirements/{id}/correct` records a human
qualification correction. `POST /v1/fit/summaries` reads at most 1,000 selected
jobs in one request. `/v1/fit/evidence-map`, `/v1/scoring/keywords`, and
`/v1/scoring/policy` retain the audit and policy surfaces.

Events are `FitAssessed`, `FitCorrected`, `FitRequirementCorrected`, and
`FitCoverageUpdated`, carrying IDs and revisions only. Failure responses never
include private model prose. Failed factual refreshes preserve the last accepted
score; expression-preparation failures cannot lower a factual score. A stale
coverage caller receives no positive composition edge. Honest `not_recorded`
coverage can still be source-fenced for a complete baseline with visible gaps.

## Verification boundary

Recurring verification belongs to the fresh integrated E2E suite. Owner proof
uses the real Python HTTP application, SQLite, Profile and Requirements actions,
and a controlled loopback external-model transport. Static compilation and
lint remain useful. These checks do not establish real-provider quality,
packaged runtime behavior, browser rendering, or the integrated Temporal worker;
those remain separate integration evidence.
