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
| Requirement-level person qualification | `FitService.assess_job` / `Qualification.resolve_many` / `fit.assess` | Reuse current authority first; one strict source-bound batch covers the entire missing requirement set against complete factual sources. Never inferred from a resume or word overlap. |
| Reuse across jobs | `Qualification.resolve_many` | Keyed by Profile ID, canonical requirement ID/revision and the complete factual source/achievement fingerprint. A new job occurrence changes priorities without repeating qualification; an all-current set makes zero qualification calls. |
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
| Independent requirement library | `requirement_library` | The complete canonical catalog, latest recorded assessment with actual achievement IDs, historical exact wording relations and separate user associations. No job traversal, semantic inference or model work. |
| User requirement associations | `create_association`, `set_association_state`, `association_history` | Revision-bound user intent, always unassessed. Soft removal and restoration preserve original pins and immutable history; they never write qualification, coverage, score or approval. |
| Maintained wording assignments | `set_current_wording`, `publish_current_wordings` | One exact current wording per Profile/achievement/canonical-requirement pair, with immutable assignment revisions. A wording can serve several requirements; multiple maintained wordings require a complete source-bound grouped exception. |
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

## Batched qualification authority

`Qualification.resolve_many` reads current authorities for the full job
requirement set before inference. Any previously accepted qualification whose
facts or canonical revision changed still returns `fit_refresh_required`;
initial job assessment cannot silently refresh that authority. Existing accepted
single-requirement assessments remain reusable under the same source keys and
retain their original provenance.

All missing requirements enter one `fit.qualification-batch` determination,
prompt `fit-qualification-batch-v1`, in the existing `scoring` lane. The request
supplies the complete factual inventory once and namespaces each requirement as
`requirement:<id>`. The strict wire is `{ requirements: QualificationDecision[] }`.
It must contain each requested ID and exact revision once, with no missing,
duplicate or foreign row. A row's requirement citations must bind its own
meaning. No requirement source can prove candidate facts or stand in for a
different requirement. There are no chunks, truncation, semantic retries,
lexical fallback or new raw-result cache.

The raw batch is re-read through its immutable gateway receipt ID and checked
for exact value, operation, prompt and provider/model/lane/input provenance.
All row schemas and source/evidence bindings validate before
`FitStore.publish_assessments` publishes the complete new set atomically under
Profile, guidance, posting, Requirements, expected-assessment-head and
cancellation guards. Each row has its own assessment identity, canonical
revision and `provenance.qualification_result_fingerprint`. Rows share the
batch determination/receipt ID and `provenance.accepted_result_fingerprint` of
the raw batch. The shared raw fingerprint must not be described as the row's
result fingerprint. Score publication retains its separate final guards.

Manual refresh uses the same batch wire only after its complete-catalog impact
decision and within its frozen selected scope. It prepares selected requirements
without completed checkpoints in one batch, checkpoints the complete map before
individual rows, and reserves one model call for that batch. Existing affected-
item limits, deadlines, failure/partial-result reporting and explicit admission
remain. Saves, reads and wording approval start no work. Batching changes neither
provider/model/effort policy nor qualification semantics or score arithmetic.

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

`GET /v1/fit/requirement-library?profile_id=default` returns `catalog_revision`,
Profile/factual/wording revisions and `requirements`. Each entry contains the
current canonical meaning, a nullable recorded `assessment` (including
`achievement_ids`, citations and determination), exact `coverage` rows and
separate `associations`. `current_wordings` contains active maintained assignment
heads, including visibly stale ones; `wording_assignments` also retains removed
heads for recovery. Coverage receipt freshness is not a maintained selection.
Currentness is determined from recorded canonical
revisions, factual-source fingerprints, assessment IDs and exact approved
variant fingerprints. Historical coverage remains labeled stale; a source
reference or manual association cannot stand in for achievement support. Before
Profile creation, the catalog remains readable with
`readiness: "profile_required"` and null Profile versions; absent assessment is
not a negative qualification judgment.

User associations have separate persistence and explicit endpoints:

- `POST /v1/fit/associations` requires a client-generated `association_id`,
  `profile_id`, `expected_profile_revision`, `requirement_id`,
  `requirement_revision`, `achievement_id`, `achievement_source_refs`, and
  optional `wording`. Wording binds `variant_id`, `variant_revision`,
  `exact_text` and `source_refs`. The entire creation is fenced against the
  current public Profile and Requirements snapshots in one write transaction.
  A repeated identity with the exact original request returns its current
  saved record; changing the request under that identity conflicts. Only one
  active association per Profile/achievement/canonical-requirement pair is
  allowed, independently of its optional wording pin.
- `POST /v1/fit/associations/{id}/revisions` takes the creation fields plus
  `expected_revision`. It retains the pair and association identity while
  explicitly revising the requirement/source pins or optional wording. The
  current Profile and all new exact pins are checked again before publication;
  the previous association remains immutable history.
- `POST /v1/fit/associations/{id}/state` requires `profile_id`,
  `expected_revision` and `state: "active" | "removed"`. A change adds an
  immutable association revision. Restore retains original requirement,
  achievement-source and wording pins; it cannot adopt newer inputs, even if
  this leaves the restored link stale.
- `GET /v1/fit/associations/{id}/history` returns retained revisions, including
  removal/restoration, with `current_revision`, `total`, `limit`, `offset`
  and `rows`. History pages default to 50 and allow at most 200 records.

Every association records `origin: "user"` and
`assessment_status: "unassessed"`, independently of its active/removed state
and current/stale bindings. An optional wording association does not approve
that wording or assert expression coverage. These writes emit only
`FitAssociationUpdated` with invalidation IDs/revisions. They do not change a
Profile version, qualification, coverage relation, score, approval or accepted
resume, and never admit model work. A user must deliberately run the existing
affected-matches operation to reassess saved factual inputs; a manual link
itself is not semantic evidence.

Maintained wording is a different record with `assignment_id`, monotonic
`revision`, Profile/achievement/requirement IDs, exact requirement and variant
revisions, `approval_id`, positive coverage `relation_id`, source pins and
`selection_provenance`. The unique pair excludes requirement revision so a
meaning correction cannot create a second simultaneous head. The current
assignment and every earlier revision remain inspectable.

- `POST /v1/fit/current-wordings` requires `profile_id`,
  `expected_profile_revision`, `expected_revision` (zero before the first
  assignment), `achievement_id`, `requirement_id`, `requirement_revision`,
  `variant_id`, `variant_revision`, `approval_id` and `relation_id`. Only a
  current exact approved variant and its current positive coverage receipt can
  be selected. Exact no-ops are allowed. A manual change must result in one
  distinct exact wording for that achievement; otherwise
  `fit_wording_consolidation_required` directs the user to **Update affected
  matches**. A partial activation of an approved replacement across its
  intended/prior requirement set is also refused.
- `POST /v1/fit/current-wordings/{id}/state` takes `profile_id`,
  `expected_revision`, and `state: "active" | "removed"`. Removal preserves
  history. Restoration checks the original exact positive bindings and the
  same single-wording guard; it cannot restore stale authority.
- `GET /v1/fit/current-wordings/{id}/history` returns bounded immutable
  assignment revisions, with the same pagination and freshness fields as
  association history. Replaying an exact successful set/revise/state request
  is accepted only when the stored request fingerprint and immediately next
  revision still agree; intervening writes conflict.

Grouped publication joins its persisted group determination, full supported
requirement inventory, exact approved-wording inventory and recorded selected
pairs. Multiple wordings require the persisted consolidation exception. It
atomically fences and replaces the complete achievement group, refuses dropping
still-supported or unresolved prior mappings, and retains assignment history.
Literal qualification revalidation may update a mapping's coverage receipt ID
only by following its recorded positive `revalidated_from` ancestry with the
same semantic qualification, meaning and exact variant/approval fingerprints.
The original selection authority and revision lineage remain recorded. This
reuses authority without another model selection or a lexical fallback.
Publication updates a running manual refresh's accepted mapping fingerprint
in the same transaction, preventing its own commit from looking like an
unrelated writer while still rejecting concurrent user selections.

These assignment writes emit `FitCurrentWordingUpdated`; they grant no wording
approval and do not alter historical coverage or accepted resume bytes. No
old approved variant is globally deleted or relabeled as unapproved. Consumers
join maintained selections and separately fence their mapping fingerprint;
historical document acceptance keeps its recorded selection and source rules.

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

Events are `FitAssessed`, `FitCorrected`, `FitRequirementCorrected`,
`FitCoverageUpdated`, `FitRefreshUpdated`, `FitAssociationUpdated`, and
`FitCurrentWordingUpdated`, carrying
IDs and revisions only. Failure responses never
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
