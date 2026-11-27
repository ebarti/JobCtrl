# Requirements

Requirements owns the `requirements-v2` generation: reusable Skills and
Professional Experience meanings, their immutable revisions, exact posting
occurrences, and job-local Education and Language demands. Its configured model
owns extraction, source interpretation and equivalence. Fit owns factual
qualification and scoring; Profile owns candidate facts and approved wording.
`bootstrap.build_feature(runtime, jobs=...)` registers the HTTP routes and
versioned durable actions through the public Jobs posting/currentness port.

## Meaning and source authority

Extraction reads the complete exact saved posting description. Title, company
and location metadata are not separately supplied or interpreted. A
content-derived source ID identifies the complete description without a job ID,
posting revision or observation timestamp. The source text is untrusted data.

The extraction call first classifies the substantive posting language using
owned verbatim evidence. An English posting may produce `complete`; material
ambiguity refuses acceptance. A non-English posting produces
`unsupported_language`, source evidence and empty item arrays. This is a
recorded exclusion outcome, not a zero score or translated posting. Preparation
stops before qualification and scoring.

The model extracts demonstrable skills and explicitly requested broad
professional background. An inferred name may express the competence implied
by the source, without importing techniques, quality checks or other demands
that its evidence does not establish. Source-described ordinary activities,
methods, quality checks and outcomes stay within one coherent skill;
responsibilities do not become one item per task. A shared action, sentence or
broad outcome does not unite different objects of professional judgment.
Independently demonstrable capabilities remain separate; a joint capability
requires source evidence of their interaction or integration. Decomposition
follows the posting rather than catalog targets, and separate capabilities may
reuse their owned quote. Explicit named-technology expertise remains
identifiable, while examples and alternatives
belong in source notes. A generic parent skill requires additional demanded
competence. Future work alone establishes no prior-background prerequisite.
An explicitly requested professional track record stays historical in its
background definition, including its material achievements; a related present
capability elsewhere cannot replace that record.
Every distinct in-scope demand must remain in the returned definitions;
attaching its quote or claiming that it was grouped in rationale or source notes
cannot preserve omitted meaning. Independently demanded capabilities and
background prerequisites retain their own categories. Technical practice,
software implementation and technology use remain Skills when phrased as
experience or prior work. Professional Experience requires a separate source-
established role, domain or operating-context prerequisite.

One explicitly accepted choice among prior fields, roles or environments can
itself define a single Professional Experience prerequisite. The normalized
job demand retains which backgrounds qualify. A shared technical practice
with example tools remains a Skill. Separately requested skills or background
retain their own evidence. Material doubt about what the source requires
continues to refuse the complete comparison.

Personal attributes, certifications/licenses, job conditions, benefits and
application instructions are excluded. Numerical duration/tenure analysis is
excluded, including empty generic experience residues manufactured by removing
a duration threshold. Excluded material does not become unresolved work.
Education retains its qualification, subjects and any explicit equivalent-
experience alternative. Languages retain the stated proficiency without an
invented proficiency scale. Offered language classes establish no requirement.
There are no generated tiers, weights, scopes or importance labels.

The source-bound prompt preserves the reviewed v6 decomposition and equivalence
rules. In particular, implementing a strategy does not by itself establish
hands-on execution; guide/lead/implement wording or seniority alone cannot
justify a different identity. Matching compares the actual competence and its
owned evidence. It cannot invent a scope distinction to justify novelty.
Capability identity describes the competence's core, independently of one job's
complete demand. Ordinary assessment, audience, method and outcome facets do not
justify another identity. Genuine source-established conditions remain in the
normalized job demand and cannot be omitted or imposed on other jobs. Invalid
extraction or genuine ambiguity refuses acceptance. Binding and meaning
corrections pass the same complete normalization boundary before publication.

Each raw quote is `{evidence_id, source_id, quote}`. Every quote must be nonblank,
verbatim, contiguous, unique in its exact source, and used by the language
classification or an extracted item. Every evidence reference must resolve to
that source's quote inventory. The application derives Python character offsets
without normalization, first-match selection or a repair call. An inferred item
requires a recorded rationale. Unsupported or malformed results preserve prior
accepted state.

## Extraction and accepted DTOs

The strict single-posting extraction response contains:

- `status`: `complete`, `needs_review` or `unsupported_language`.
- `language`: `classification` (`english`, `non_english` or `uncertain`),
  source-bound `reason`, and `evidence_refs`.
- `quotes`: the owned exact quote inventory.
- `requirements`: `local_id`, `category` (`skill` or
  `professional_experience`), `name`, `definition`, `basis` (`explicit`,
  `inferred` or `explicit_and_inferred`), `rationale`, nullable `source_note`,
  and `evidence_refs`. The v6 provider schema requires a nonblank rationale
  for both inference bases. A fully explicit demand may use null or explain a
  non-obvious boundary. Each staged v5 extraction or existing refresh attempt
  retains its original prompt, schema and receipt identity during recovery.
- `education`: `qualification`, `subjects`, nullable `alternative` and
  `source_note`, and `evidence_refs`.
- `languages`: `language`, nullable `proficiency` and `source_note`, and
  `evidence_refs`.
- `unresolved`: source-owned material ambiguity (`question`, `reason`,
  `evidence_refs`). A complete response has none.

Accepted snapshots add `contract_version: requirements-v2`, exact job/posting/
source identities, monotonic snapshot `revision`, catalog revision, the immutable
extraction receipt ID and `extraction_provenance`. Their quotes include derived
`start` and `end` values. Read projections add `stale`, `stale_reasons` and
`latest_attempt`.

Each reusable occurrence retains its original extracted name, category,
definition, basis, rationale, source note, evidence references and spans.
`requirement_id`, `requirement_revision` (also `revision`) and a nested
`canonical: {contract_version, category, name, definition}` separately record
its accepted binding. Canonicalization and binding correction never replace the
original interpretation. Occurrences retain exact destination posting/source
versions, semantic source identity and immutable extraction/matching receipts.

Education and Languages stay in the snapshot's `education` and `languages`
arrays. Each has its original fields, category `education` or `language`, a
`requirements-v2:direct:` identity derived from its exact destination posting,
field and value, revision 1, exact spans and extraction provenance. These IDs
are job-local. Direct fields never enter catalog equivalence, the reusable
library or achievement-wording authoring.

The public `snapshot_items(snapshot)` adapter requires this generation, a complete
extraction and `normalization_version: requirements-capability-demand-v2`.
It returns detached per-occurrence assessment rows retaining `original`.
Canonical ID/revision/category/name identify the capability; `capability_definition`
retains its core. `definition`, `demand_fingerprint` and `demand_provenance` bind
the normalized combined source demand being assessed. Same-job occurrences of
one capability agree on that demand and are counted once by Fit. An old accepted
snapshot remains readable but cannot supply current assessment inputs until
explicit consolidation; the adapter refuses `requirements_consolidation_required`.
Direct rows expose `requirement_revision`, `occurrence_id`, `name` and the exact
structured direct meaning serialized as JSON. The adapter makes no semantic
judgment and does not mutate the accepted snapshot.

## Complete matching and exact reuse

One `requirements.match_catalog` determination uses semantic policy
`requirements-capability-demand-v2`. It sees the complete incoming Skills/Experience
inventory and retained current-generation catalog, including hidden meanings.
Canonical sources contain their definitions, original extraction and quoted
posting evidence; accepted occurrences and available posting sources establish
job demands. The inventory binds its epoch, complete ID/revision set and source
authority. There is no top-k selection, paging, chunking, lexical fallback or
separate novelty judgment. Existing-only repair and every semantic ingestion or
correction use this mandatory gate.

New single-job refreshes use `requirements-capability-demand-partition-v11-cited-occurrences`.
The request supplies named column lists for repeated object shapes, a dictionary
of repeated whole strings across context and sources, and shared citation path
layouts. Each source retains its own ID and its explicitly offered segment IDs.
The owner reconstructs the complete context and each canonical source before
dispatch and again for binding. It checks the whole context, source and citation
hashes. Every member, occurrence and group handle remains an individually
required property in the response schema, with shared JSON Schema definitions
for their slot types. A capability group can reuse only an assigned retained
capability whose category, name and definition agree verbatim. With no retained
capability the only permitted reuse choice is null.

The complete serialized request must fit the gateway's 1 MiB limit and the
selected provider's context. Capacity depends on the number of distinct
requirements, original postings, and source text as well as the number of jobs.
A refusal preserves the accepted snapshot without truncating, splitting or
automatically resending the request.

Every V11 occurrence slot marks its source as `cited` or `unresolved`. The model
assigns each cited occurrence once by selecting an offered segment of its
original source in exactly one demand group. Posting and inventory citations
retain their evidence roles. The owner verifies complete, unique occurrence
membership, one capability per demand, and one demand for each job and
capability. The receipt records the original response, the bound assignment map
and the expanded decision fingerprints. Earlier V10 operations retain their
explicit occurrence-to-group selections and reject contradictions with citations.

Each V10 or V11 demand group makes one source-bound choice. `keep` selects the sole
accepted demand found in its assigned occurrence sources and can apply it to
new occurrences assigned to that group. If the group has zero or several
distinct prior demands, the owner refuses `keep`. `select` identifies one exact
offered prior demand by its short source ID. The accepted-demand table pairs
that ID with the full definition and member IDs. Both choices retain the exact
accepted definition and signature, require the matching category and a shared
retained member, and cite every original occurrence. `author` supplies a new
complete definition. The receipt binds the raw choice, expanded selection and
final decision. Earlier table comparisons retain their original response schema.

The durable `requirements.refresh` action records its transport in its original
admission transaction. Searches record it in their initial preparation request
and carry that request into retries. A missing marker selects v6, including
unstarted jobs in a frozen search. A recorded v8 uses its original source
string and citation path dictionaries. Previously paid requests retain their
exact fingerprints and one-call allowance. Each active format preserves the
source-established alternative-background instruction. Synchronous and durable
single-job refreshes use V11 cited occurrence assignments, explicit catalog repair, corrections and
independently started Preparation use v6, and shared initial-search cohorts
use v7. Every earlier v6, v7, v8, v9 or v10 operation keeps its original
instructions through recovery. An explicitly admitted fresh action may reuse
its validated extraction when the source and execution binding still match.

The v6 immutable model result, `CatalogNormalizationSlots`, contains `status`, exact
`catalog_revision`, `member_slots`, `occurrence_slots`, `capability_groups`,
`demand_groups` and `corrections`. Its strict operation-specific schema requires a
property for every supplied member and occurrence. Each slot is `assigned` or
`unresolved`. Assigned members select a supplied `capability_group_id`; assigned
occurrences select a supplied `demand_group_id`. The independent handles are
pre-offered in `context.partition_group_handles` and shared schema enums. Capacity
allows every input to remain separate; it is not a target group count.

Both group maps require every offered handle. Unused handles are null; every used
handle has one terminal `kind: group` definition. Capability definitions own
normalized category/name/core, reason, citations and nullable exact reuse authority.
Demand definitions own complete normalized demand, citations and nullable exact
reuse authority. A group cannot alias another group or choose a representative.
The model alone selects membership. `requirements-partition-binding-v2` joins
those selections to the recorded occurrence/member/job identities. All occurrences
assigned to one demand group must share one capability, and every job/capability
must select one demand group. Used-but-null and non-null unused groups refuse
publication. Equivalent jobs may explicitly share a demand group.

Group handles carry no durable identity. Code selects the stable persisted
survivor only after the model's partition. No recursive graph or inferred root
exists in v5. Explicit unresolved slots refuse publication; required slots
establish accounting, not semantic correctness. Missing/foreign properties,
invalid reuse, foreign citation references, stale targets and uncertainty also
refuse the complete result. One determination is allowed per admitted operation;
invalid output never triggers a repair loop or partial publication.

The input's `citation_segments[source_id][segment_id]` catalog selects exact
locations in the source, without duplicating full prose. A path array means one
complete decoded JSON string value. An object supplies `value_path` and explicit
`start`/`end`; `source_format` defaults to `json_string`. Only values longer than
the existing 4,000-character quotation bound are losslessly subdivided at physical
newline or fixed character boundaries. The full source remains supplied once in
the same request; there is no semantic paging or call fanout. A short literal
preview locates a long-value segment. Inventory citations use an exact serialized
epoch fragment. Models select offered segment IDs, never calculate offsets,
copy/paraphrase quotes, or join fields.

V6 citation source IDs are finite offered enums, scoped to the output field's
existing authority. Demand evidence permits only inventory, occurrence sources,
and postings with a matching offered occurrence's job/revision/hash. The final
validator still checks the narrower actual demand's bound occurrence/posting set.
Accepted-demand definition documents stay available for verbatim copying and
`reuse_demand_fingerprint`; they are never offered as original demand evidence.
Capability, correction and unresolved citations retain their broader supplied-source
vocabulary and existing mandatory-source/witness checks. Segment IDs retain their
existing string format and exact source/segment binding; the schema does not repeat
the entire segment inventory in enums. Unknown sources fail schema validation;
foreign segments, mismatched source/segment pairs and unauthorized bound sources
still fail the existing owner checks. No citation is silently removed or repaired.

The deterministic `requirements-citation-binding-v1` binder validates the source,
path, range and catalog fingerprints, then derives exact `Citation` quote fields
in a separate `CatalogNormalization` projection. Generic extraction and other
features keep their existing citation contracts. The partition binder first
derives a separate citation-reference projection. The citation binder's
`selection_fingerprint` pins that intermediate projection; it never claims to
pin the raw slots. `partition_binding.raw_selection_fingerprint` and the gateway's
`accepted_result_fingerprint` pin the unchanged raw model selection/cache/receipt.
The intermediate fingerprint joins the two binders, and the final derived
fingerprint pins the exact-quote projection. The reconciliation keeps raw slots
in `decision_json` and stores `intermediate_selection`, `derived_decision`,
`partition_binding` and `citation_binding` separately in the existing report JSON
envelope, versioned `requirements-normalization-binding-v3`. Frozen SQL schemas
do not change. Old flat reports, citation-binding-v1 and normalization-binding-v2/v3
envelopes remain readable. Pure historical validation dispatches explicitly by
the original prompt version, including the unchanged v4 graph decoder and exact
v5 schema. The v6 prompt/schema supplies a fresh request and durable action identity
without changing any binder, semantic policy or accepted-demand fingerprint.
Runtime never falls back to an old wire.
The public report exposes `partition_binding` with both fingerprints, explicit
`member_groups`, `occurrence_groups` and derived `demand_capabilities` joins, plus `citation_binding`
fingerprints, the complete structural `source_context`,
per-source fingerprints and the exact segment catalog. Context pins recorded
meaning IDs/revisions, ordered retained families, occurrence/snapshot identities,
extraction/correction receipts, previous-occurrence lineage and immutable posting
revisions. Readers join these recorded identities rather than infer earlier heads
from a hash or current order. Root/occurrence provenance keeps binding digests and
the reconciliation ID alongside its derived exact quotes.

The response also retains explicit source-correction witnesses. Original posting
evidence outranks previous extracted definitions. A witness can remove an
unsupported attribution from a retained historical member only when that member
has no accepted occurrence, including on deleted jobs. It pins the exact old
claim, its own original source, `member_id`, separately source-supported
`represented_by_member_id` and reason; retained/preservation groups derive from
those declared capability assignments. All genuine current demands still participate in the complete partition;
the witness cannot split current occurrences or invent a technical subtype.
Reconciliation/certificate and root-revision provenance retain the correction,
including when the surviving core text is otherwise unchanged.

The feature cache binds the entire sent request: operation, prompt/instructions,
strict schema, every source/context value and one frozen provider/model/effort/
nonsecret-configuration descriptor. Budget and lane admission remain live.
Content-derived source IDs permit exact description extraction reuse across
jobs; similar text or normalized whitespace cannot establish an exact hit.
Matching additionally binds the entire catalog and incoming inventory. Forced
actions include their stable operation ID, allowing same-action recovery while
requesting fresh authority for a different force action.

A cache entry is accepted only after source/schema checks and joining its
succeeded immutable gateway receipt. A stopped worker can recover an exact
settled receipt after those same checks. Corrupt or mismatched accepted cache
authority refuses reuse; it does not authorize a fresh fallback call. A raw
result invalid under owner rules is never accepted cache authority. Destination
`source_binding` separately records the real job/posting versions without
rewriting the shared semantic result or implying another provider call.

A refresh performs extraction and one complete consolidation determination. An
explicit existing-only consolidation performs one determination. Durable call
intent accounting prevents an interrupted operation from resetting allowance;
only exact settled authority may be recovered. A source/catalog race refuses
the captured work rather than starting an automatic repair loop. The complete
description remains bounded to 192,000
bytes and the gateway enforces its complete serialized input limit before
provider admission. Size, context, lane, capacity, budget and provider refusals
preserve accepted state without smaller requests or automatic repair calls.
An unsupported-language, empty or direct-only extraction with no reusable items
uses a narrow extraction-authorized snapshot publication instead: it makes no
canonical, alias or certificate changes and no normalization call. Its original
posting and accepted-head fences still apply.

## Initial Search

Each eligible posting enters Requirements independently. Its full accepted
text binds extraction reuse. Catalog normalization sees the retained catalog
and the incoming occurrences for that posting. Fit receives its accepted
snapshot, including exact posting, demand and receipt identities.

### Retained cohort operations

Durable Requirements refresh and Preparation wait through temporary model
capacity contention. The gateway transaction records an extraction or
normalization dispatch reservation when it allocates the provider receipt.
An interrupted capacity wait leaves the operation eligible for admission. An
already reserved, unsettled dispatch retains its recovery fence.

Preparation calls `prepare_cohort_job` for each frozen job. Each posting keeps
its original extraction local IDs, immutable source hash, extraction receipt and
expected accepted revision. A job-scoped member ID distinguishes an `r1` from
another job's `r1`. Staging a receipt leaves the accepted snapshot untouched.

`finalize_cohort` submits one complete retained catalog and all staged reusable
occurrences to `requirements.match_catalog`. Its
v7 cohort wire stores repeated exact
source strings and citation path descriptors in request-local dictionaries. The
owner verifies that expansion restores every original document and the complete
context. The model can explicitly select a retained capability or demand
definition with a `reuse` group. Its original membership, category, source
roles, citations and exact definition must pass the full partition validator.
The reconciliation records the raw selection, expanded group fingerprint and
source-bound citation projection.

The commit checks the complete catalog, posting and accepted snapshot versions.
Direct-only and language-excluded jobs retain their own extraction authority.
If the cohort has no reusable incoming rows, its new snapshots commit together
using the extraction receipts. Recovery reads the committed revisions or an
exact successful gateway receipt under the original request identity. An
unsettled dispatch retains its one-call reservation. A refused extraction keeps
its own receipt ID so a retry of that operation preserves the validation error.
Preparation settles the corresponding attempt with its terminal failure or
cancellation in the same transaction. Interrupted workers can resume the original
attempt. Permanent job removal erases affected private staging and keeps an
operation tombstone to fence replay.

## Generations, history and publication

Existing SQL schema strings remain unchanged. A separately initialized
`requirements_normalization_v1` extension owns aliases, reconciliation records,
call intents and the current certificate. New meaning JSON, occurrences,
snapshots, semantic requests, cache provenance and action fingerprints explicitly
use `requirements-v2`; new canonical IDs use its namespace. Missing generation
means legacy. Catalog snapshots, library reads and repairable index views expose
only current-generation meanings. An older meaning never becomes current by
resemblance. The global catalog epoch and job snapshot revisions remain
monotonic.

Legacy accepted snapshots, meaning revisions, occurrences and receipts remain
readable with `stale_reasons: [contract_changed]`. They cannot pass currentness
checks, enter a current catalog, qualify new work or resume/replay as new
operations. Versioned durable actions reject incompatible action replay before
returning old terminal results. Current actions additionally bind the normalization
policy, and old typed snapshots expose `consolidation_required` staleness. No
read, save or generation transition starts
model work. Operational rollout requires stopped old writers and a workspace
backup; rollback after new writes restores that backup.

Inference occurs outside the write transaction. Publication checks cancellation,
the complete captured catalog/member heads, affected accepted snapshot heads and
public Jobs posting identities in one transaction. It appends changed capability
revisions, explicit aliases, replacement Requirements snapshots and the
reconciliation certificate together. Unchanged semantic bindings retain their
versions and authority. Historical rows are never rewritten. Source/catalog races
refuse publication; failed, cancelled or interrupted work retains the previous
accepted snapshots, scores, wording approvals and document bytes. Current
navigation may follow a recorded alias; exact historical revision reads do not.

The model wire uses operation-local citation handles; real capability, member,
occurrence and job IDs remain unchanged. Context references and supplied source
entries use the same handles, and the immutable receipt retains the exact model
result without an output-ID decoder. No prose or source inventory is truncated.
For the owner's JSON-encoded sources, citation validation accepts an exact
contiguous quote within the raw source or one decoded string value from that
same source. It never joins fields, reparses embedded text, normalizes whitespace
or supplies meaning through a lexical fallback. Plain-source validation remains
raw-only by default.

Explicit binding correction requires the complete normalization result to put
the selected source and target in the same capability. Canonical correction
applies the same scope/exclusions and whole-catalog gate. Both retain
source-bound receipt authority and explicit user reasons. Public
`assert_current` and `assert_current_catalog` can join a consumer's transaction.
Requirements writes emit invalidations; they do not schedule Fit or wording work.

Scoped occurrence correction is `requirements.correct_occurrences` or
`POST /v1/jobs/{job_id}/requirements/corrections`. It accepts the exact
`expected_posting_revision`, accepted `expected_revision` and 1–20 distinct
`corrections: [{occurrence_id, reason}]`; the durable payload also includes
`job_id`. Reasons guide the task and are never factual evidence. The accepted
snapshot must be current, English and complete. Direct demands are not selected.

One source-bound model batch returns exactly one corrected reusable meaning per
selected occurrence ID, using owned verbatim posting quotes. Split, merge,
deletion, extra/missing IDs, unsupported evidence and ambiguity refuse the
operation. This corrected batch enters the same whole-retained-catalog
consolidation. Original fields of unselected occurrences remain unchanged;
their capability/demand bindings can be reconciled under the complete captured
source authority. There is no arbitrary catalog edit or direct SQL merge.

Publication rechecks the exact prior snapshot and every original canonical head,
posting revision/hash, catalog epoch and cancellation in one transaction. All
occurrences receive new physical IDs and `previous_occurrence_id` because IDs
are globally unique. Unselected original semantic fields and evidence are
retained. Direct/language arrays are retained. Corrected fields name
the correction receipt/result fingerprint as their current authority, retaining
prior extraction under `provenance.origin`. New meanings cite the correction and
matching receipts. The snapshot retains its full original extraction provenance,
adds namespaced correction quotes and appends `correction_history`.

The operation permits one correction batch and one complete normalization call.
Append-only intents reserve allowance before dispatch; exact settled authority
can be recovered without another call. An unsettled reserved input refuses
instead of spending again. Worker recovery cannot reset allowance. Races cannot
expand the selected set; changed captured input refuses publication. These
writes admit no Fit followup.

## Public entrypoints

| Entry point | Contract |
| --- | --- |
| `GET/HEAD /v1/jobs/{job_id}/requirements` | Accepted snapshot with currentness, or JSON null for an existing unassessed Job. No work. |
| `POST /v1/jobs/{job_id}/requirements` | `expected_posting_revision`, `expected_revision`, optional `force`. |
| `GET /v1/requirements` | Bounded active catalog; `q` is a literal user filter. |
| `POST /v1/requirements/consolidate` | Explicit existing-only repair with `expected_catalog_revision` and optional stable `operation_id`. |
| `GET /v1/requirements/index` | Active-generation index counts and exact freshness. |
| `POST /v1/requirements/index/rebuild` | Mechanical active-index repair under `expected_catalog_revision`, zero model calls. |
| `GET /v1/requirements/{requirement_id}` | Current or exact historical meaning, original provenance and accepted occurrences. |
| `GET /v1/requirements/{requirement_id}/history` | Bounded revisions or occurrences with accepted/current/stale reasons. |
| `POST /v1/jobs/{job_id}/requirements/{occurrence_id}/binding` | Versioned explicit binding correction with selected target and reason. |
| `POST /v1/jobs/{job_id}/requirements/corrections` | Source-bound one-to-one correction of selected occurrence meanings and bindings. |
| `POST /v1/requirements/{requirement_id}/revisions` | Versioned source-bound canonical correction. Proposed shape is the extracted requirement plus exact spans. |
| `requirements.consolidate`, `requirements.refresh`, `requirements.correct_binding`, `requirements.correct_occurrences`, `requirements.revise` | The same actions through the durable dispatcher, each versioned `requirements-v2:requirements-capability-demand-v2:requirements-capability-demand-partition-v6`. Durable consolidation uses the run identity and accepts `expected_catalog_revision`. |

Only one durable consolidation can be pending or active per workspace. The
admission transaction refuses a mismatched catalog revision with
`requirements_consolidation_catalog_changed` and the current revision. A
previously admitted request keeps its exact identity and still checks the
catalog before inference and publication.

Public owner methods also include nullable `find_job_requirements`, required
`get_job_requirements`, exact/historical `get_requirement`, full
`catalog_snapshot`, `assert_current_catalog`, `demand_catalog_snapshot`,
`assert_current_demand_catalog`, `normalization_status`, `assert_current`, and bounded
`job_bindings`. Bindings include generation/status, accepted/current revisions,
the normalized job demand fingerprints used by Fit and explicit source readiness.
When the scored and accepted groups differ, this read can prove continuity from
the exact immutable extraction, typed direct criteria and published catalog
replacements. A new extraction or explicit correction requires comparison of
the new accepted demands.
Restoring an accepted posting with the exact original source hash keeps its
evidence valid at the new posting revision. New extraction and publication pin
the actual posting head. Returned JSON is detached and reads make no provider
calls.

`normalization_status` reports policy version, catalog epoch, `ready`,
`reconciliation_id` and the certificate's epoch. The complete demand catalog
retains normalized variants, snapshot heads and posting tokens; its optional
active projection excludes semantic work for deleted-only jobs while the
retained catalog remains the identity-matching source. Consolidation reports
the captured/new epochs, complete member-to-root mapping, root definitions,
affected jobs and immutable model receipt. An alias cannot transfer assessment,
coverage or approval authority. Fit consumes demand-scoped recorded bindings.

`library_catalog_snapshot` is a separate read projection: accepted reusable
occurrences count only while their Job exists and is not soft-deleted. Jobs'
public batched snapshots supply liveness in the same read transaction; hidden
Jobs still count. `/v1/requirements` filters this membership before its literal
query and pagination. Fit uses the same projection for its complete library.
Deleting the last live root retires a meaning from both lists, while restore
recovers its existing identity, links and history with no inference. Direct
detail/history reads retain the meaning and report `active_in_library`.
Soft deletion retains the complete `catalog_snapshot`, canonical heads,
retrieval index and semantic matching inventory; old Fit support, user links and
accepted documents do not independently establish active-library membership.

Permanent deletion participates in Jobs' authorized transaction and deletes
that job's snapshots, occurrences, attempts and owned cache rows. Meanings with
no occurrence on any other retained Job are physically removed, including their
heads, revisions, retrieval rows and revision-action links; shared meanings
survive even when their other Job is soft-deleted or its occurrence is historical.
Registered public owner deletion ports remove dependent Fit relations before
canonical meanings are removed, in the same transaction. Catalog revision
advances, and an already stale retrieval index stays stale. Profile facts,
approved wording and independent immutable model receipts remain retained.
Direct detail/history reads for a permanently removed meaning return 404.
Creation IDs bind the monotonic catalog epoch, so a later identical extraction
after purge cannot reuse a deleted ID/revision and revive old provenance.
Errors expose safe codes without posting/model prose. Source/schema failures
are 422, contract/revision/cancellation conflicts are 409, and complete-input
catalog refusal is 503 `requirements_catalog_unavailable` with safe metadata.
The attempt stores these details transactionally under its exact completion.
`GET /v1/jobs/{job_id}/requirements/attempts/latest` reports them for first-use
and refresh failures, including the gateway receipt ID when a provider fails
or a settled extraction fails source validation. A
legacy attempt without recorded details keeps its original failure code.

## Verification

Use the actual public application journeys in `docs/local-reliability-qa.md`
with owned synthetic state and controlled external provider boundaries. Cover
legacy retention and zero automatic calls, complete matching and category
boundaries, exact reuse and receipt recovery, all four categories, language
exclusion, invalid/ambiguous/foreign evidence, catalog/source/publication races,
corrections, cancellation and worker recovery. Static checks do not establish
semantic accuracy or product-level completion. Keep real posting trial inputs
and outputs outside the repository.
