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

## Requirements Library And Associations

The redesign candidate composes three public owners: Requirements supplies
canonical meanings/history, Profile supplies facts and exact wording, and Fit
supplies recorded assessments, coverage and unassessed user associations. This
is a source contract; the [redesign ledger](../plans/2026-11-11-original-app-redesign.md)
records integrated verification separately.
The active library contains Skills/Professional Experience only. Direct
Education/Languages demands remain in their job snapshot and Fit result.

| Route | Contract |
| --- | --- |
| `GET /v1/requirements/{requirement_id}/history` | `kind=revisions\|occurrences`, `limit=1..200` (default 50) and nonnegative `offset`; returns `{requirement_id,current_revision,kind,total,limit,offset,rows}`. Occurrences retain exact accepted posting/meaning revisions and report `current`/`stale_reasons`. |
| `GET /v1/fit/requirement-library?profile_id=default` | Complete current catalog with nullable recorded `assessment`, exact `coverage`, separate unassessed `associations`, active `current_wordings` heads (including stale heads) and all `wording_assignments` heads. Returns Profile/fact/wording/catalog revisions and `readiness: ready\|profile_required`. An absent Profile has null Profile revisions, not invented evidence. |
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

Checks preserve source and timing provenance. Failure or inability to fetch is
not a confirmed closed posting. See [jobs lifecycle](complete-contract.md#jobs-read-model-and-lifecycle).

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

## Actual Offers

Offers owns terms, scenarios, decisions and correction history separately from
market compensation. Unknown terms stay unknown. Changes do not themselves
submit an application or send a communication.

## Feedback Learning and Materials Policy

Corrections and feedback remain inspectable and user-controlled. Learning
activity is not evidence of a capability and does not alter Fit. Policy and
artifact updates preserve previously accepted versions until explicitly changed.
