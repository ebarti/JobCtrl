# Jobs and Materials API

Feature-owned Python HTTP adapters are being integrated. These are target
ownership and lifecycle semantics; consult the current adapters for exact paths,
methods, fields and status codes. A route declaration alone is not proof of a
working product journey.

## Jobs and Evidence

Jobs owns capture, identity and versioned posting snapshots. The current work in
`features/jobs/bootstrap.py` declares `/v1/jobs`, capture and job snapshot
routes; the integrated candidate must verify them. Manual Jobs works without
Discovery or Companies. Requirements owns qualified source meanings and Fit
owns person/evidence qualification; no reader should recompute semantic
relationships with word matching. The in-progress `features/requirements/http.py`
declares the catalog and job requirement routes; `features/fit/http.py`
declares job fit, assessment, corrections and coverage. These declarations
still need composed application and E2E verification.

`GET /v1/jobs/{job_id}/snapshots` includes recorded capture attempts. A failed
employer analysis keeps `failure_code: role_analysis_failed` and, when available,
stores up to three underlying `{code, provider, model}` entries in
`attempts[].data.failures`. Provider and model identify the actual frozen
selection, including the default model. This diagnostic evidence excludes
prompts, citations, source text and arbitrary exception context. Failure retains
the last accepted analysis; reading the history starts no retry or model work.

Recognized posting-fetch refusals retain `posting_fetch_blocked` or
`posting_fetch_unavailable`; unclassified fetch exceptions retain
`posting_fetch_failed` with an explicitly unknown cause. Their capture attempts
include `data.captureFailure: {stage: "posting_fetch", kind, reason_code}` with
only safe identifiers. Recognized blocking reasons come from the acquisition
policy; unavailable or unclassified failures keep `reason_code: "unknown"`.
HTTP 429/503 from a configured page provider describe that provider's rate limit
or unavailability, not the target posting's status. Failed fetches preserve the
accepted posting and start no model work or automatic retry.

Fresh employer-analysis requests use `role-analysis-v3-offered-sources` (and the
corresponding synthesis version). Their citation schema permits only the exact
offered canonical source IDs; quote and semantic validation remain unchanged.
Accepted v2 analyses remain readable and reusable when the current posting,
provider/model/effort/configuration fingerprint, recorded source binding and
immutable receipt/citation authority still match. This structural upgrade does
not sweep existing jobs or promote an unaccepted v2 cached response.

## Typed Job Requirements

`GET /v1/jobs/{job_id}/requirements` exposes the accepted job snapshot.
`POST` on the same route requests an explicit revision-fenced refresh with
`expected_posting_revision`, `expected_revision` and optional `force`.
New snapshots carry `contract_version: requirements-v2` and contain:

| Field | Meaning |
| --- | --- |
| `status` | `complete` or `unsupported_language` |
| `language` | Source-bound `classification: english\|non_english\|uncertain`, `reason` and `evidence_refs` |
| `quotes` | Exact `evidence_id`, `source_id`, `quote`, `start` and `end` references into the frozen posting |
| `requirements` | Reusable Skills/Professional Experience occurrences and their canonical binding |
| `education` | Direct job-local Education demands |
| `languages` | Direct job-local Languages demands |
| `unresolved` | Retained source ambiguities |
| `extraction_provenance` | Recorded extraction/model authority and source bindings |

A reusable occurrence retains its original `category`, `name`, `definition`,
`basis`, `rationale`, `source_note`, `evidence_refs` and `spans`, alongside its
canonical IDs/revisions and nested
`canonical: {contract_version, category, name, definition}`. Its original
meaning is not replaced by the catalog label. The active catalog categories
are `skill` and `professional_experience`; canonical rows have no generated
scope, qualifier, tier or importance-weight fields. Qualifications and meaningful
alternatives remain in the source-bound definition and occurrence evidence.

Education demands retain `qualification`, `subjects`, `alternative` and
`source_note`; Languages demands retain `language`, `proficiency` and
`source_note`. Both retain exact source metadata/spans and a job-local
`requirement_id` with `revision: 1`. They do not appear in `GET /v1/requirements`,
the Fit requirement library or achievement-wording authoring. Their identities
cannot authorize another job's qualification.

A source-bound English-language decision runs before extraction. An accepted
`unsupported_language` result has empty demand arrays and retains its language
evidence; preparation skips Fit and creates no score. Uncertainty, invalid output,
provider refusal and stale sources cannot publish an invented empty fit result.
Personal traits, certifications/licenses, job conditions and detailed tenure
analysis are outside this contract. Structured certification work is tracked in
[#1476](https://github.com/ebarti/JobCtrl/issues/1476).

Current catalog reads return only `requirements-v2` meanings. Missing versions
are legacy. Retained detail/history reads preserve accepted old fields and include
`contract_changed` in `stale_reasons` where applicable; they are not
silently promoted. Incompatible refresh/resume/replay is refused before new
publication. Historical ordering and accepted artifact bytes remain available.
See [generation and rollout](../architecture/scoring.md#generation-history-and-rollout).

`POST /v1/jobs/{job_id}/requirements/corrections` repairs selected reusable
occurrence interpretations without re-extracting the other demands. The strict
body is `expected_posting_revision`, accepted `expected_revision` and
`corrections: [{occurrence_id, reason}]` with 1–20 distinct current occurrence
IDs. Durable `requirements.correct_occurrences` uses the same body plus `job_id`.
Reasons are task guidance, never source evidence. The posting and accepted
snapshot must be current, English and complete.

One source-bound revision batch must return exactly one corrected meaning for
each selected occurrence. Existing complete-catalog matching resolves only that
batch. The operation cannot add, split, merge or delete occurrences, change
direct demands, or revise global catalog meanings. All physical occurrence IDs
change with `previous_occurrence_id` links; unselected meaning/binding/evidence/
provenance fields remain exact copies. Selected meanings name their correction
receipt and result fingerprint as current authority, with earlier provenance
under `origin`. The original full extraction provenance remains on the snapshot,
and `correction_history` records the separately accepted correction stage.

Posting/snapshot identity, all original canonical heads, catalog epoch and
cancellation fence publication atomically. Failure preserves accepted history.
At most five new call intents are admitted across worker recovery; settled exact
authority is reused, while a previously reserved unsettled input refuses with
409 `requirements_correction_call_unsettled`. This action does not start Fit or
wording work. It differs from binding correction, which preserves the original
interpretation, and global canonical revision, which can stale other jobs.

## Typed Fit Results

New Fit JSON carries `contract_version: requirements-v2`. Its `formula_version`
and `policy_version` are `requirement-fit-v3-equal`. The score summary records
`qualification_coverage`, `assessed_count`, `supported_count` and `blocker_count`.
The retained `weighted_fit` compatibility field is the same equal-item average;
it does not restore posting weights. An empty assessed set has `assessed_count: 0`
and null `qualification_coverage`, `score`, `computed_score`, `fit_band` and
`confidence`. With job conditions excluded, the compatibility `eligibility`
value is neutral `unknown`, with empty eligibility blockers/warnings.

Assessments retain `category`, `name`, `definition`, `text`, exact `evidence_refs`
and `achievement_ids`. `evidence_route` is `education`, `equivalent_experience`
or null; `wording_support` is `section`, `achievement` or `none`.
Coverage's `section_support` rows record `{requirement_id, assessment_id,
category, evidence_refs}` and prevent a supported section from becoming a false
achievement-wording gap. Direct Education/Languages demands remain outside the
reusable coverage/library/authoring inventory. Their qualification still
contributes an equal item to the job score.

Legacy Fit reads return `current: false` with `contract_changed` in
`stale_reasons`. Incompatible Fit operations refuse with HTTP 409
`contract_changed`; incompatible generic durable-action replay uses
`action_contract_changed`. For an accepted unsupported-language posting, a
read retains any prior score with `unsupported_posting_language` staleness, and
a new assessment refuses with that code rather than publishing a replacement.
The existing public routes remain. Reusable requirement correction accepts
optional `wording_support` and `evidence_route`; the canonical correction route
cannot correct a direct job-local demand. Exact adapters and the
[Fit reference](../../workers/automation/src/jobctrl/features/fit/README.md)
remain authoritative for validation and error envelopes.

The durable `fit.refresh` action accepts `prepare_coverage` as a strict boolean,
defaulting to `true`. For a qualification-and-score-only refresh, explicitly pass
both `prepare_coverage: false` and `prepare_wording: false`; the action completes
after factual publication without expression-coverage or authoring calls. A
coverage-disabled request cannot include wording retries or enable wording
preparation. Operation reads retain both frozen preparation flags. Previously
frozen operations without the new flag retain enabled coverage and their existing
request identity.

When a manual Fit qualification was paid but a revision conflict prevented
publication, a new explicitly admitted refresh can recover one settled exact
qualification for the same Profile and selected jobs. It verifies the full
gateway input and execution identity, then rechecks every returned requirement
and its source evidence. A successful recovery exposes
`counters.qualification_receipts_reused` and consumes no new provider call.
Ambiguous and unsettled exact receipts produce
`fit_refresh_qualification_receipt_ambiguous` or
`fit_refresh_qualification_receipt_unsettled`. The previous action remains
stale and its score cannot be published.

Fresh refresh operations expose independent `impact_selection_scope_version` and
`qualification_transport_version` pins. Complete frozen scope is preserved while
exact current qualifications and mandatory reassessments are resolved before an
optional single impact call over uncertain changed-fact items. Fixed decisions
have structural provenance; the original subset model receipt remains separately
bound to the composed complete partition. Pre-pin retained calls keep exact
historical request recovery and unsettled-call refusal. These operation wire
versions do not change accepted qualification/currentness policy or reset limits.

## Requirements Library And Associations

The redesign candidate composes three public owners: Requirements supplies
canonical meanings/history, Profile supplies facts and exact wording, and Fit
supplies recorded assessments, coverage and unassessed user associations. This
is a source contract; the [redesign ledger](../plans/2026-11-11-original-app-redesign.md)
records integrated verification separately.
The active library contains Skills/Professional Experience only. Direct
Education/Languages demands remain in their job snapshot and Fit result.
Membership requires an accepted occurrence on at least one existing nondeleted
Job; hidden Jobs count. Both `GET /v1/requirements` and the composed Fit library
apply this rule before filtering or pagination. Deleting the last such Job
removes the meaning from those lists; restoring it recovers the same IDs and
history. Existing support, associations and wording selections remain retained
but do not independently keep a deleted-only meaning active. Profile capabilities
and accepted documents are unchanged. These reads and visibility changes make
no model calls. `catalog_revision` identifies the retained semantic catalog,
so a visibility change can alter library membership without changing that epoch.
Reviewed permanent job deletion removes canonical meanings only when no other
retained Job occurrence references them, including superseded occurrences and
soft-deleted Jobs. Requirements removes its heads/revisions/index/action links
and increments the catalog epoch; registered Fit cleanup removes its owned
requirement relations in the same transaction. Profile facts and approved
wording, independent model receipts and remaining Jobs' meanings survive.
Exact detail/history reads for a permanently removed meaning return 404.
Later identical source extraction creates a different canonical identity after
purge; it cannot revive removed revision pins or Profile links.

| Route | Contract |
| --- | --- |
| `GET /v1/requirements/{requirement_id}` | Retained current or exact historical meaning and accepted occurrences, including meanings outside the active library. `active_in_library` distinguishes current membership from retention. |
| `POST /v1/requirements/consolidate` | Explicit source-bound existing-only consolidation: `{expected_catalog_revision,operation_id?}`. The durable `requirements.consolidate` action accepts `{expected_catalog_revision}` and uses its run ID. |
| `GET /v1/requirements/{requirement_id}/history` | `kind=revisions\|occurrences`, `limit=1..200` (default 50) and nonnegative `offset`; returns `{requirement_id,current_revision,active_in_library,kind,total,limit,offset,rows}`. Occurrences retain exact accepted posting/meaning revisions and report `current`/`stale_reasons`. |
| `GET /v1/fit/requirement-library?profile_id=default` | Complete active library with nullable recorded `assessment`, exact `coverage`, separate unassessed `associations`, active `current_wordings` heads (including stale heads) and all `wording_assignments` heads. Returns Profile/fact/wording/catalog revisions and `readiness: ready\|profile_required`. An absent Profile has null Profile revisions, not invented evidence. |
| `POST /v1/fit/associations` | Requires stable `association_id`, `profile_id`, `expected_profile_revision`, `requirement_id`, `requirement_revision`, `achievement_id`, exact `achievement_source_refs`, and `wording: null` or `{variant_id,variant_revision,exact_text,source_refs}`. |
| `POST /v1/fit/associations/{association_id}/revisions` | The association creation fields plus `expected_revision` revise the optional wording/source pins while retaining the stable Profile/achievement/requirement pair, ID and history. One active manual association exists per pair. |
| `POST /v1/fit/associations/{association_id}/state` | `{profile_id,expected_revision,state: active\|removed}` performs revision-fenced soft removal/restoration; it preserves original source pins. |
| `GET /v1/fit/associations/{association_id}/history` | Profile-scoped paginated immutable revisions, with current revision, total, limit and offset. |
| `POST /v1/fit/current-wordings` | Requires `profile_id`, `expected_profile_revision`, `expected_revision` (`0` for creation) and exact achievement/requirement-revision/variant-revision/approval/positive-coverage-relation pins. Records a maintained assignment, not new semantic authority. |
| `POST /v1/fit/current-wordings/{assignment_id}/state` | `{profile_id,expected_revision,state: active\|removed}` changes an assignment under its exact revision; restoration refuses stale or absent positive coverage. |
| `GET /v1/fit/current-wordings/{assignment_id}/history` | Profile-scoped immutable assignment revisions, default 50/max 200 per page, with current revision, total, limit and offset. |

Every user association remains `origin: user` and `assessment_status: unassessed`.
Creation checks current requirement, achievement/source, Profile and optional
exact wording revisions. An exact same-ID/body retry reuses its identity; changed
input cannot overwrite it. A later source, meaning or wording change marks its
original pins stale. Restoration does not claim freshness or reassess anything.
These writes make no model call, qualification, coverage, score, wording approval,
resume change or automatic refresh. Readers join recorded IDs and revisions;
they do not infer links from labels or text similarity.

The `requirements-capability-demand-v2` policy makes complete retained-catalog
consolidation mandatory for semantic publication. Its report contains captured
and published catalog epochs, input member count, canonical roots, complete
member-to-root mapping, affected jobs, reconciliation identity and model receipt.
Catalog reads include `normalization` status/version/certificate and recorded
aliases. Exact historical revision reads preserve their original identity;
current navigation may follow a recorded alias. Old typed job snapshots report
`consolidation_required` staleness and cannot supply new assessment authority.

The read-only `GET /v1/jobs/{job_id}/requirements/attempts/latest` returns the
latest attempt for an existing job, or null before its first attempt. It also
works before the first accepted snapshot. `failure_code` identifies a refusal.
Where recorded, `failure_details` preserves the source-free counts, catalog
revision, reason and model error from a complete-input refusal, or the gateway
receipt ID for a dispatched provider failure or an extraction rejected during
source validation. Historical attempts report only
the fields that were recorded. The original Requirements read remains an
optional accepted snapshot.

Consolidation uses semantic policy `requirements-capability-demand-v2`. Explicit
catalog repair and corrections use `requirements-capability-demand-partition-v6-background-v1`.
New single-job refreshes and new searches on the per-job route use
`requirements-capability-demand-partition-v11-cited-occurrences`. Every occurrence
slot declares `cited` or `unresolved`. A demand group assigns an occurrence by
citing an offered segment of its original source. The owner rejects an occurrence
cited by zero or multiple groups. Every accepted group still belongs to one
capability and supplies one complete demand per job and capability. Each demand group
chooses `keep` for the sole accepted demand bound to its occurrences, `select`
for a specific offered prior demand source, or `author` for a new full
definition. A choice of `keep` can also bind newly assigned occurrences when
the selected prior demand applies to them. Multiple distinct prior demands
require an explicit source selection or an authored definition. The response
retains the original evidence citations for every occurrence. Shared
initial-search cohorts use `requirements-capability-demand-partition-v7-cohort-background-v1`.
The instruction revision clarifies a single prerequisite that accepts any of
several prior backgrounds. Existing action IDs retain their admitted instructions.
Named columns identify the exact fields in each repeated row. References select whole source strings
and each source explicitly lists its available segment IDs beside its citation
path layout. The owner verifies the reconstructed context and original source
documents before dispatch and when binding the response. Groups can select
only a retained capability ID for `reuse_requirement_id`. With no retained
capabilities this field requires null. Previously admitted work keeps its
original v6, v7, v8 or v9 format through retry. The complete input must fit the existing
1 MiB gateway bound and the selected provider's context.
All three versions use `CatalogNormalizationSlots`, which requires a property for every supplied member
in `member_slots` and every occurrence in `occurrence_slots`. Each slot is assigned
to an independent pre-offered capability/demand group handle or explicitly
unresolved. `capability_groups` and `demand_groups` require every offered handle:
used groups contain terminal normalized definitions/citations/reuse choices;
unused groups are null. No groups can alias other groups, so recursive cycles are
unrepresentable. Capacity permits every input to remain separate, without setting
a target count. Models choose all semantic memberships. The owner only joins
those assignments to recorded input member/occurrence/job identities.
Missing definitions, unused non-null groups, demand assignments across capabilities,
multiple demands for one job/capability and uncertainty refuse publication.
Group citations select supplied `{source_id,segment_id}` references. The owner
derives exact quotes from one source value/range using
`requirements-citation-binding-v1`; the model never copies a quotation or calculates
offsets. Full source evidence remains in one complete determination per operation.
Generic extraction, Fit and other feature citation formats are unchanged.

V6 source-ID enums enforce citation roles before owner publication. Demand evidence
can select inventory, occurrence sources and postings with a matching offered
occurrence's job/revision/hash. The owner still checks every citation against the
actual demand's bound occurrences and eligible postings. Supplied prior normalized
demand definitions are reuse context only: select `reuse_demand_fingerprint` to
request exact reuse, without citing that definition as original evidence. Other
citation fields retain their broader supplied-source vocabulary and existing
required-source/witness rules. Segment IDs keep their existing format; the exact
source/segment binder remains authoritative. No model-selected citation is dropped
or rewritten to make an invalid response acceptable.

The report's `partition_binding` is versioned `requirements-partition-binding-v2`
and contains `raw_selection_fingerprint`, `intermediate_fingerprint`, exact
`member_groups`/`occurrence_groups` assignments and derived `demand_capabilities`
joins. Group handles carry no durable identity and never choose a persisted survivor.
The report's `citation_binding` contains `binder_version`, `selection_fingerprint`,
`derived_fingerprint`, `segment_catalog_fingerprint`, `source_fingerprint`,
`source_context_fingerprint`, complete structural `source_context`, per-source
`source_fingerprints` and the supplied `segment_catalog`. These pin real meaning
and ordered family revisions, occurrence/snapshot IDs, extraction/correction and
lineage references, and immutable posting revisions. The citation selection
fingerprint pins the intermediate reference projection, equal to the partition
binding's intermediate fingerprint. The gateway accepted-result fingerprint
always pins the raw slots. Raw model selection/cache/gateway authority is retained
unchanged; intermediate selection, derived quotes and both bindings are stored
separately in the existing reconciliation's JSON envelope, versioned
`requirements-normalization-binding-v3`. Old v2/v3/v4/v5 history remains readable and
explicit pure validation remains tied to its original prompt/input, including the
exact v5 schema. V6 changes prompt/schema identity only; binder and envelope
versions remain unchanged. No SQL schema,
capability identity policy or normalized-demand fingerprint changes are implied
by the citation format. Durable Requirements action versions and idempotent input
hashes include the partition wire so an old quote/array/graph action cannot resume as a
current terminal-group action. This transport guarantees input accounting, not
semantic correctness or a particular model latency.

Reusable occurrences retain their original extracted definition and exact source
evidence plus `normalized_demand` containing its definition, fingerprint, policy
version and source-bound provenance. The assessment adapter exposes canonical
ID/revision/category/name, `capability_definition`, normalized demand `definition`,
`demand_fingerprint` and `demand_provenance`. Same-job occurrences of one capability
share one combined demand; direct Education/Languages remain job-local.

Fit library rows add `assessment_scope`, `assessment_summary` and
`demand_assessments`. Each demand row retains its definition, fingerprint,
applicable jobs and actual recorded assessment/currentness. Multiple demands
report `varies_by_job` with no representative scalar assessment; incomplete old
source inventory reports `consolidation_required`, including any verified partial
rows without claiming a complete assessment. No strongest/latest sibling can
become global support. Qualification, coverage, refresh checkpoints and
publication fences retain the exact demand and policy version. Maintained common
wording heads retain per-demand assessment/relation bindings under one exact
approved variant; an uncovered demand remains a gap.

Normalization's explicit correction witness is bounded to a retained historical
member with no accepted occurrence, including deleted jobs. It pins the exact
unsupported prior claim, original source, retained group and preserved demand
group. Original definitions stay immutable history; active occurrence splitting
and invented subtype/scope are refused. The same complete determination and
atomic source fences apply—there is no separate per-member correction call.

Incomplete/uncertain partitions, invalid reuse/citations, cancellation, stale
catalog/posting/snapshot heads and payload/provider refusal preserve accepted
records. No partial consolidation, automatic downstream refresh, lexical fallback
or per-item inference fanout is admitted. See the
[decision](../decisions.md#capability-consolidation-and-source-demand).

Maintained assignments are distinct from user associations. They bind exact
current approved wording and recorded positive coverage (`approval_id` and
`relation_id`) to the canonical requirement and achievement revisions. Their
`current` flag describes binding freshness; an active stale head remains visible
with `stale_reasons` and cannot pretend to be current authority. Selection
provenance and prior assignment revisions remain inspectable.

Manual assignment permits exact reuse or a result with at most one distinct
wording variant for the achievement. A change that would maintain additional
distinct variants returns `409 fit_wording_consolidation_required`, with explicit
affected-match refresh as the remedy. Only the source-bound grouped decision
can authorize a justified distinct-coverage exception. No lexical comparison or
user-authored intended-requirement ID supplies that authority. Assignment writes
perform no new inference or approval and do not replace accepted resume bytes.

History exposes retained accepted canonical revisions and source occurrences.
An old occurrence is not a failed refresh promoted into accepted state. Failed
attempts keep their existing attempt APIs, and a changed posting revision makes
the occurrence's freshness explicit. See the
[Requirements library guide](../user/requirements-library.md) for the user flow.

## Saved Posting Availability

`GET /v1/jobs/{job_id}/availability` reads the last confirmed state and time
(`last_confirmed`) and latest attempt (`last_attempt`) for the saved URL. Either
can be null. `POST` requests a manual check. The UI warns at 24 hours. Failed
and inconclusive attempts preserve the previous confirmation. See [jobs lifecycle](complete-contract.md#jobs-read-model-and-lifecycle).

## Artifacts and Resume Templates

Resumes owns approved wording selection, coverage manifest, editable documents,
rendering, templates, acceptance and exports. Bind approval and download to the
exact artifact and source revisions. Failed replacement, rendering or export
preserves prior accepted material. One advisory coherence review has a status
separate from user acceptance; a mechanically valid document can be accepted
with an explicit override of a finding or timeout. The in-progress
`features/resumes/http.py` declares `/v1/resumes` and routes for editing, review,
rendering, acceptance, export and locales; these still need integrated proof. See
[tailoring](../architecture/tailoring.md).

Resume list/detail reads include
`composition_freshness: {current,stale_reasons,revision_id}`. The pure read checks
recorded Profile, Requirements and Fit pins; it does not move the current draft
or accepted pointer. Reasons include `profile_changed`, `profile_unavailable`,
`requirements_changed`, `fit_coverage_changed` and `coverage_not_recorded`.
Changing the job-relevant assignment fingerprint reports `fit_coverage_changed`.
It covers canonical requirement IDs, participating achievement IDs and matching
assignment heads, including a previously missing head becoming present.
Unrelated requirement assignments do not stale that composition.
Baseline mode skips Fit/Requirements currentness while still checking Profile
freshness. A stale result offers explicit preparation; it does not regenerate,
hide accepted bytes or invent a fresh assessment.
New-generation currentness rejects legacy requirement/Fit authority for new
composition while retaining historical accepted artifacts. Tailoring preserves
all baseline sections, including Language / Proficiency, and changes only
approved achievement wording. Each eligible canonical requirement receives one
composition policy point; that coefficient is never posting metadata.

## Apply Review and Outcomes

Applications consumes the exact accepted resume and owns screening answers,
approval of the application payload, assisted execution and outcomes. Changed
inputs invalidate stale approval; ambiguous external outcomes cannot be silently
retried. See [apply](../user/apply.md) and
[security](../developer/security.md#apply-path-containment).

## Screening Answers

Applications owns reviewed answer revisions and their application context.
Profile evidence remains Profile-owned. A prior answer or resume approval does
not approve a new application payload.

## Contacts and Outreach

Contacts and Outreach are separate features. Contacts owns provenance, import
and research; Outreach owns reviewed drafts, decisions, send records and
follow-up state. Changes and sends require current revision/authorization
checks; creating a draft is not a send. See [contacts](complete-contract.md#contacts).

## Interviews Catalog, Preparation, and Notes

Interviews owns its catalog, source-bound preparation and independent notes.
Explicitly empty evidence selections remain empty; a failed generation leaves
accepted preparation and notes intact.

## Compensation

Compensation owns posted and market evidence, source policy and normalization.
Source availability and currency/time-base uncertainty must be represented
honestly. Its neutral core does not depend on JobCtrl storage or workflow IDs.
After a refresh verifies posted pay, `GET /v1/jobs/{id}/compensation/posted`
returns the cited fact while market research continues. A failed market
refresh leaves the latest accepted estimate available at
`GET /v1/jobs/{id}/compensation/market` with its own source revision.
For a title-sourced determination the posted fact's `sourceField` is `title`
and its receipt binds the exact saved title, posting ID and revision. The
structured amount, currency, period and component are the model's verified
result. Each market comparison retains the posted source it used.

For `GET /v1/jobs/query`, `posted_known=source_known` selects current
employer-posted facts with at least one numeric bound in the source currency
and period. `source_unknown` selects its complement, including stale and
unassessed facts. Clients can discover these modes in
`capabilities.posted_pay_filters`. Existing `known` and `unknown` values and
the `posted_min_eur` and `posted_max_eur` filters use annual EUR bounds.

## Actual Offers

Offers owns terms, scenarios, decisions and correction history separately from
market compensation. Unknown terms stay unknown. Changes do not themselves
submit an application or send a communication.

## Feedback Learning and Materials Policy

Corrections and feedback remain inspectable and user-controlled. Learning
activity is not evidence of a capability and does not alter Fit. Policy and
artifact updates preserve previously accepted versions until explicitly changed.
