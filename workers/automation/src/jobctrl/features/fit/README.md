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
| Factual edits | `fit.refresh` / `fit.catalog-impact` | Manual, fixed-input operation. One complete-catalog decision selects affected requirements, including previously missing support. Unchanged support retains original semantic authority with current-source revalidation. Saves and approval never start it. |
| Capability score | `domain.calculate_score` | Retains `requirement-fit-v2-scoped`: direct 1, strong .85, transferable .6, must-have multiplier 1.25, four-decimal contributions, half-up 1–10 mapping and capability-blocker cap 4. Eligibility/logistics/employer conditions contribute no points. |
| Confidence and eligibility | `get_job_fit` | Persisted model verdicts and cited reasons remain separate from points. Compensation/location/work-model preferences are warning categories. Unknowns remain unknown. |
| Live minimum-fit selection | `minimum_fit_score`, `get_job_fit.selection` | Reads the shared versioned setting without recomputing a score. A score must be current and unblocked to be ready. |
| User score correction and calibration history | `correct_score` / `fit.correct` | Adds a new immutable score version and correction anchor while retaining the computed score, source report and stale state. One correction does not silently change arithmetic or qualification. |
| User qualification correction | `correct_requirement` | Requires the exact assessment, factual Profile version, canonical requirement revision and literal current evidence. Invalidates only scores/relations that used the superseded assessment. |
| Approved expression coverage | `refresh_coverage`, `coverage_for` | Separate strict model decisions join canonical requirement revision, accepted qualification, achievement, exact variant revision, approval and source versions. Unsupported facts never receive positive coverage. |
| Grounded wording preparation | Achievement-group coverage / Profile public `request_authoring` | Reuse exact current relations first. Consider an achievement's relevant requirement set together, then request one coherent supported proposal only for meaningful expression gaps. Origin excludes the job; rejected/deferred requests remain retained. Only Profile's explicit user action can approve. |
| Baseline/off composition | `assess_job(prepare_coverage=False)` | Person qualification may run; no wording-coverage or authoring call runs. `prepare_wording=False` alone suppresses proposals while still preparing exact coverage. |
| Evidence reverse links | `evidence_map` | Public source/requirement/score/determination IDs, exact source excerpts, recorded qualification gaps, exact variant/source relations and current/stale usage. Absent coverage stays `not_recorded`; only complete recorded noncoverage or no approved variant establishes a wording gap. |
| Keyword filters | `keywords` | Latest accepted model-supplied labels, NFKC/whitespace normalization and casefold lookup keys; normalization never decides support. |
| Jobs and Digest composition | `query_summaries`, `summary_for_jobs`, `digest_summary` | Bounded bulk score/assessment queries and public Requirements binding reads share the caller's snapshot. Stored high-fit values and stale state remain distinct. Cutoffs compare UTC instants at millisecond precision, including equal cutoffs. |
| Durable restart | `fit_operation_receipts`, `fit_refresh_operations` | Fixed scope, input versions, call reservations, checkpoints and limits survive restart. Exact retries reuse committed work. An interrupted external call stays explicit instead of silently spending a new allowance. Factual publication and failed expression preparation are reported separately. |
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

Post-edit qualification through older assessment/coverage commands returns
`fit_refresh_required`; initial missing qualification remains available to
explicit job preparation. Manual refresh uses:

- `GET /v1/fit/refresh/pending?profile_id=default`: returns HTTP 200 with
  `readiness: "ready"`, a saved-input stamp, recorded pending reasons,
  available/stale scored-job IDs and latest operation when Profile exists.
  Before Profile creation it returns only
  `{ "profile_id": "default", "readiness": "profile_required" }` (using the
  requested Profile ID), also with HTTP 200. This state supplies no input stamp,
  counts or invented currentness; callers show Profile setup and cannot start
  new refresh work. Only absence at the public Profile snapshot boundary gets
  this readiness result; catalog, job and other source failures remain errors.
  Existing operation/status reads remain available independently, and refresh
  execution still requires a real saved Profile. The pending read makes no
  model call and does not claim the affected requirement set before selection.
  `pending_wording_failures` follows current canonical retry successors and
  source bindings independently of the latest operation, so retrying one failed
  proposal cannot hide another unresolved proposal.
- `POST /v1/actions/fit.refresh`: `profile_id`, explicit `job_ids` (up to 100,
  empty allowed for catalog relationships only), required
  `expected_input_fingerprint`, `prepare_wording`, and `limits`. Defaults admit
  up to 40 model-call attempts, 100 affected qualifications, 20 wording proposals and
  600 seconds. The full catalog is never truncated to meet a work limit.
- `GET /v1/fit/refresh/operations/{operation_id}`: fixed scope, phase, selected
  IDs, counters, deadline, failure code and partial-publication boundary. For
  an already admitted action, `?allow_pending=true` returns `null` until its
  feature operation exists; it does not establish action admission. The default
  remains 404 for an absent operation.
- `POST /v1/action-runs/{run_id}/cancel`: the shared durable cancellation path.

An explicitly selected `retry_wording_proposal_ids` array uses the same action
with an empty job scope to retry failed or semantically uncertain authoring.
It defaults to empty and does not authorize unrelated proposal work. Exact
current source/achievement/requirement bindings and prior outcome are checked
before work; pending, approved, rejected and deferred proposals cannot be
retried through this option. Each new attempt records its predecessor, while
an exact retry of its action identity reuses that attempt. Failed/uncertain
wording remains visible as unfinished work rather than a completed update.
Prior attempts remain history; a successful subset retry does not clear
unselected failures.

The action admission stamp covers saved facts, approved wording, guidance,
catalog and prior recorded assessments/jobs. One active action per profile is
enforced even before a worker starts. A new key cannot bypass an existing run;
`action_scope_busy` identifies it. The worker also fences captured input at
publication. Catalog, Profile or selected job changes cannot expand the plan.
Pending proposal bookkeeping does not count as new approved input.

The `model_calls` counter reserves an attempt before gateway/provider admission;
it includes a refused or uncertain attempt and does not prove a provider charge.
Manual operation limits are separate from the gateway's lane/workspace spend
admission. Responses explicitly report `hard_monetary_bound: false`; neither a
model-call count nor a daily spend threshold guarantees a maximum final charge
for an external provider call. No real-provider spend QA follows from this API.

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
