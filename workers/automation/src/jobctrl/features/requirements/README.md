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
Equivalence must preserve what the candidate has to demonstrate when either
complete meaning replaces the other. Shared topics and ordinary-facet wording
cannot add or drop independently established capabilities or background demands.
A valid incoming meaning with only broader, narrower or partial catalog
candidates is new if the complete catalog has no equivalent; invalid extraction
or genuine ambiguity still refuses acceptance. Binding correction applies the
same comparison in both directions to its selected target.

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
  `inferred` or `explicit_and_inferred`), nullable `rationale` and `source_note`,
  and `evidence_refs`.
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

The public `snapshot_items(snapshot)` adapter requires this generation and a
complete extraction. It returns detached per-occurrence assessment rows, using
the recorded canonical meaning for reusable items while retaining `original`.
Direct rows expose `requirement_revision`, `occurrence_id`, `name` and the exact
structured direct meaning serialized as JSON. The adapter makes no semantic
judgment and does not mutate the accepted snapshot.

## Complete matching and exact reuse

One `requirements.match_catalog` determination sees the complete incoming
Skills/Experience inventory and the entire active canonical catalog. Canonical
sources contain each definition/category/name plus its original extraction and
quoted posting evidence. The catalog inventory binds its epoch, full ID/revision
set and source meanings. There is no top-k selection, paging, chunking, lexical
fallback or separate novelty judgment.

Every incoming local ID receives exactly one `equivalent`, `new` or `uncertain`
verdict. Canonical equivalence names an exact catalog ID/revision. Incoming
equivalence points directly to an earlier genuinely new representative, never a
chain. Cross-category substitution, unknown/duplicate/missing IDs, stale targets,
invalid source citations or any uncertainty refuse the whole result. Each
decision cites the posting, its incoming meaning and the complete inventory;
equivalence also cites its selected target. All occurrences remain recorded.

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

A refresh permits extraction and at most four complete-catalog attempts under
concurrent publication. The complete description remains bounded to 192,000
bytes and the gateway enforces its complete serialized input limit before
provider admission. Size, context, lane, capacity, budget and provider refusals
preserve accepted state without smaller requests or automatic repair calls.

## Generations, history and publication

Existing SQL schema strings remain unchanged. New meaning JSON, occurrences,
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
returning old terminal results. No read, save or generation transition starts
model work. Operational rollout requires stopped old writers and a workspace
backup; rollback after new writes restores that backup.

Inference occurs outside the write transaction. Publication uses one
transaction to check cancellation, expected accepted revision, the public Jobs
posting revision/hash, and the captured catalog epoch before appending meanings,
occurrences and the snapshot and moving the accepted pointer. A catalog race may
repeat one bounded complete matching determination. Posting or accepted-state
changes refuse publication. Failed, cancelled or interrupted work retains the
previous accepted snapshot and historical artifacts.

Explicit binding correction compares only the selected current-generation
target with the original occurrence, then publishes a new immutable snapshot.
Canonical correction applies the same scope/exclusions and a whole-catalog
check, appends a revision and leaves older bindings visibly stale. Both retain
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
operation. Only this corrected batch enters the existing whole-active-catalog
determination. It may reuse an existing meaning or append a new one; it cannot
rewrite a canonical meaning or reinterpret an unselected occurrence.

Publication rechecks the exact prior snapshot and every original canonical head,
posting revision/hash, catalog epoch and cancellation in one transaction. All
occurrences receive new physical IDs and `previous_occurrence_id` because IDs
are globally unique. Unselected semantic fields, binding, evidence and authority
are copied exactly. Direct/language arrays are retained. Corrected fields name
the correction receipt/result fingerprint as their current authority, retaining
prior extraction under `provenance.origin`. New meanings cite the correction and
matching receipts. The snapshot retains its full original extraction provenance,
adds namespaced correction quotes and appends `correction_history`.

The operation permits at most five new call admission intents across its durable
lifetime: one correction and at most four catalog-race resolutions. Append-only
intents in the existing owner cache reserve allowance before dispatch. Exact
accepted cache/settled receipt recovery makes no new call. A reserved input
without accepted settled authority refuses with
`requirements_correction_call_unsettled` instead of spending again. Worker
recovery cannot reset allowance. Races cannot expand the selected set, and a
changed original head refuses publication. Reads/writes admit no Fit followup.

## Public entrypoints

| Entry point | Contract |
| --- | --- |
| `GET/HEAD /v1/jobs/{job_id}/requirements` | Accepted snapshot with currentness, or JSON null for an existing unassessed Job. No work. |
| `POST /v1/jobs/{job_id}/requirements` | `expected_posting_revision`, `expected_revision`, optional `force`. |
| `GET /v1/requirements` | Bounded active catalog; `q` is a literal user filter. |
| `GET /v1/requirements/index` | Active-generation index counts and exact freshness. |
| `POST /v1/requirements/index/rebuild` | Mechanical active-index repair under `expected_catalog_revision`, zero model calls. |
| `GET /v1/requirements/{requirement_id}` | Current or exact historical meaning, original provenance and accepted occurrences. |
| `GET /v1/requirements/{requirement_id}/history` | Bounded revisions or occurrences with accepted/current/stale reasons. |
| `POST /v1/jobs/{job_id}/requirements/{occurrence_id}/binding` | Versioned explicit binding correction with selected target and reason. |
| `POST /v1/jobs/{job_id}/requirements/corrections` | Source-bound one-to-one correction of selected occurrence meanings and bindings. |
| `POST /v1/requirements/{requirement_id}/revisions` | Versioned source-bound canonical correction. Proposed shape is the extracted requirement plus exact spans. |
| `requirements.refresh`, `requirements.correct_binding`, `requirements.correct_occurrences`, `requirements.revise` | The same actions through the durable dispatcher, each versioned `requirements-v2`. |

Public owner methods also include nullable `find_job_requirements`, required
`get_job_requirements`, exact/historical `get_requirement`, full
`catalog_snapshot`, `assert_current_catalog`, `assert_current`, and bounded
`job_bindings`. Bindings include generation/status, accepted/current revisions
(including job-local direct IDs) and explicit stale reasons. Missing/deleted Jobs
remain 404. Returned JSON is detached and reads make no provider calls.

Permanent deletion participates in Jobs' authorized transaction and deletes
only that job's snapshots, occurrences, attempts and owned cache rows. Neutral
catalog meanings and independent immutable model receipts remain retained.
Errors expose safe codes without posting/model prose. Source/schema failures
are 422, contract/revision/cancellation conflicts are 409, and complete-input
catalog refusal is 503 `requirements_catalog_unavailable` with safe metadata.

## Verification

Use the actual public application journeys in `docs/local-reliability-qa.md`
with owned synthetic state and controlled external provider boundaries. Cover
legacy retention and zero automatic calls, complete matching and category
boundaries, exact reuse and receipt recovery, all four categories, language
exclusion, invalid/ambiguous/foreign evidence, catalog/source/publication races,
corrections, cancellation and worker recovery. Static checks do not establish
semantic accuracy or product-level completion. Keep real posting trial inputs
and outputs outside the repository.
