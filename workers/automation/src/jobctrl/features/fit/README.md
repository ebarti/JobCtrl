# Fit capability inventory

Fit owns person qualification, source-bound support, deterministic scores and
corrections, and the relation between a reusable requirement and exact approved
achievement wording. Profile owns facts, Language / Proficiency records, baseline
sections and wording approval. Requirements owns typed meanings, job occurrences
and direct job demands. Resumes owns selection and document acceptance.

## Typed authority and retained history

New accepted Fit documents carry `contract_version: requirements-v2`. Assessments,
score/source bindings, coverage relations and snapshots, wording requests and
assignments, associations and manual-operation state retain that generation.
Missing or different versions are historical authority. Reads retain the original
rows and artifacts, report `current: false` and `stale_reasons: ["contract_changed"]`,
and never promote them by adapting their shape. Old operation identities cannot
replay or resume; feature receipts return `contract_changed`, and the application
also fences durable action generations before returning a cached action result.
No SQL schema string changes or automatic model calls accompany this change.

Saved score currentness compares its original permitted factual inputs and the
current accepted job demand items. It compares one normalized reusable demand
per scored capability, plus the literal Education and Language criteria. Catalog
head revisions, display names, posting revision counters and occurrence order
do not independently invalidate the score. Explicit corrections to a bound
qualification are recorded as changed support. The Requirements owner can verify
a regrouping of the original extracted demands from accepted history. Its saved
score stays current with the original breakdown. `qualifications_current`
tracks current group inputs for new preparation and application work, and
`requirements_current` checks the analyzed posting source.

The reusable catalog contains only `skill` and `professional_experience`.
`education` and `language` are direct, job-local demands. Their namespaced IDs
remain tied to the job/posting and their assessments never enter the reusable
library, wording coverage or authoring. Each direct alternatives group is one
assessment item. Deleting a job removes its direct assessment records together
with its score/operation records; reusable person/requirement authority remains.

`unique_requirements` consumes Requirements' public `snapshot_items` adapter,
which joins reusable occurrences to exact canonical capability identity and the
normalized combined job demand, retaining the core definition separately.
The original source-bound extraction, source note and occurrence IDs remain
inspectable. Repeated occurrences of a canonical meaning count once. Source notes
are retained for explanation and do not affect score arithmetic. Unsupported
posting languages receive no replacement score. A prior score remains historical
with `unsupported_posting_language`; an explicit assessment is refused before
qualification work.

## One complete qualification batch

Requirements' mandatory `requirements-capability-demand-v2` consolidation owns
one capability identity plus the normalized complete demand for each job. Fit
uses that demand's definition, fingerprint and provenance, retaining the core
separately. Qualification semantics `fit-qualification-demand-v1`, the exact
prompt version, capability revision and permitted Profile evidence all bind
reuse/currentness. Every lookup, head comparison, correction, refresh checkpoint
and publication uses the same tuple. Old qualification/operation authority stays
readable but cannot become current through a changed prompt or recorded alias.

Same-job repeated occurrences yield one capability item. Identical normalized
demands can reuse exact accepted authority across jobs; different demands cannot
share one assessment simply because their capability ID is equal. Manual refresh
captures Requirements' public demand inventory and retained catalog under source
fences, qualifies only its admitted affected demand scope and scores selected
jobs. Deleted-only demands do not start new qualification work. Reads, saves,
approvals and the operation's own writes never schedule a refresh.

The library keeps one canonical row and exposes `demand_assessments` and an
explicit scope/summary. Multiple demands show `varies_by_job`, with no chosen
scalar assessment. Incomplete unnormalized source inventory remains
`consolidation_required`; verified partial rows do not claim full support.

Grouped wording coverage uses `fit-wording-coverage-demand-v1` and exact demand
and assessment pins. One common maintained variant stores all of its exact
positive `demand_bindings`; sibling gaps remain explicit. A shared batch receipt
cannot authorize another row's demand, and an alias transfers no qualification,
coverage or approval. Maintained heads participate in cached selection identity
and CAS. A singleton selection cannot silently truncate the aggregate or replace
its common text without complete-group authority. Resumes projects only its
job's applicable binding and retains one capability policy point.

`FitService.assess_job` and `Qualification.resolve_many` inspect the entire fixed
job item set, reuse exact current authority, then submit every pending category
together in one `fit.qualification-batch` determination, prompt
`fit-qualification-batch-v4-demand`, in the existing `scoring` lane. The complete Profile
source inventory is supplied once. Each item has its own capability/demand source,
category, revision, demand fingerprint and permitted evidence IDs. There are no chunks, truncated
inventories, lexical judgments, per-item semantic retries or result replay cache.
An all-current set makes zero qualification calls.

Fresh requests use lossless `fit-permission-scopes-v1` context transport. Equal
ordered permission-ID lists occur once in `permission_scopes`; each requirement
references its own `permission_scope_id`. All original facts, canonical IDs,
categories, alternatives and output fields remain unchanged. Exact inverse
expansion and source/context hashes are checked before the model call. Version,
hashes and counts are retained in opaque assessment provenance without fact text.
The encoded-context hash/byte count excludes the binding itself to avoid a
circular identity. This transport tag changes the model input fingerprint, while
v4 qualification policy, semantic/source fingerprints and currentness stay
unchanged. Earlier accepted v4 assessments remain current and reusable.

The strict response remains `{ requirements: QualificationDecision[] }`. It must
contain every requested ID/revision/demand binding exactly once. Decisions retain `kind`,
`strength`, confidence, rationale, exact citations, supported achievement IDs and
model-supplied keyword labels. They also record `evidence_route` and
`wording_support`. Only recorded authored or explicitly confirmed Profile sources
can prove candidate facts. Review-required, pending, rejected and deferred sources
remain available for inspection without becoming qualification authority.

| Demand | Permitted factual sources | Recorded route |
| --- | --- | --- |
| Skills | Structured Profile Skills and factual roles/achievements | `wording_support: section` or `achievement` |
| Professional Experience | Factual roles/achievements | `wording_support: section` or `achievement` |
| Education | Education records | `evidence_route: education` |
| Explicit education equivalence | Factual roles/achievements only when the demand explicitly offers equivalent experience | `evidence_route: equivalent_experience`; no degree assertion |
| Languages | Structured Language / Proficiency records only | Direct section support; no achievement IDs |

Structural validation enforces all cited IDs and their source ownership, exact
verbatim spans, education alternatives, route/source compatibility and achievement
ownership. A source in Skills never proves language proficiency. Requirements and
user scoring guidance cannot supply candidate facts. Models decide meaning and
support within those permitted sources; structural guards never infer semantics.

Every Education judgment citing evidence records `evidence_route`, including
missing/blocked judgments with contrary Education evidence. A supported verdict
always requires a route; unsupported Education with no citations may leave it
null. The model supplies this route explicitly; readers never infer it.

Personal traits, certifications/licenses, job conditions and detailed years of
experience are outside this iteration. The retained compatibility fields are
strictly `eligibility: unknown`, `blocker_category: null` and
`warning_category: null`. They cannot adjudicate authorization, citizenship,
clearance, compensation, location or work model. A `blocked` qualification kind
records a cited factual mismatch for a typed demand and contributes zero credit.

The accepted raw batch is reread through its immutable gateway receipt and
checked for exact result, operation, prompt, provider/model, lane and input
provenance. Every row validates before atomic publication. Rows have independent
assessment IDs and `provenance.qualification_result_fingerprint`; they share the
batch receipt and `provenance.accepted_result_fingerprint`. The shared fingerprint
is never presented as the individual row fingerprint. Source fingerprints include
the category's permitted factual inventory and scoring guidance. Language-only
edits therefore cannot invalidate unrelated Skills or Experience authority.

Publication rechecks Profile/guidance, posting/Requirements, captured assessment
heads and cancellation. Inference holds no writer lock. A job without score
history may resolve its fixed missing items during explicit initial assessment;
publication fences score revision zero and both current and historical heads.
A previously scored job with changed inputs requires manual refresh. Force never
bypasses accepted authority or refresh admission.

## Initial Search cohort

Durable Fit assessment and Preparation wait for model capacity. Initial
qualification records its attempt together with the gateway receipt in the
admission transaction. A worker can resume a capacity wait, while recovery of
an already admitted call requires its settled authority.

`qualify_cohort` receives the complete frozen job list, posting and Requirements
revisions and hashes, and each job's original score revision. It captures the
Profile, scoring guidance and current and historical qualification heads.
Eligible jobs share an assessment only when the exact binding, semantic
requirement source and permitted factual inputs agree. Existing current
qualifications are reused. One `fit.qualification-batch` call covers the
remaining bindings. Publishing that batch rechecks all captured heads in one
transaction. Each subsequent `assess_cohort_job` uses its pinned assessments
and the existing equal-item formula.

The cohort wire `fit-qualification-citation-refs-v1` also accepts an explicit
reference to the complete supplied source or a numbered line in that source.
The binder restores exact literal quotes and validates the original evidence
roles, category permissions and verdicts. Each record retains the raw batch,
raw row and expanded batch fingerprints, the expanded row fingerprint and the
source selections. A worker recovering a reserved call reads its original
gateway fingerprint and immutable successful receipt before publication. A
call without a successful receipt keeps its reservation. Permanent job removal
clears affected cohort staging and prevents the operation from restarting.

## Equal scores and user corrections

`domain.calculate_score` persists `requirement-fit-v3-equal`. Every distinct
canonical requirement and every distinct direct demand contributes one item.
Credits are direct = 1, strong = .85, transferable = .6, missing/blocked/
not-assessed = 0. For N > 0:

`score = clamp(1 + floor(9 * sum(credits) / N + .5), 1, 10)`

N = 0 produces no score: `score`, `computed_score`, `fit_band` and confidence are
null. Summary retains `assessed_count`, `supported_count`,
`qualification_coverage` and typed factual `blocker_count`. `weighted_fit` is a
compatibility alias for the same equal average. Contributions are
`{ max_points: 1, awarded_points: credit }`. There is no must-have multiplier,
source priority, tier/scope weight or blocker cap. Eligibility's compatibility
object remains unknown with empty blocker/warning lists.

Score corrections add immutable score versions and correction anchors while
retaining the computed score and original report. A correction does not repair
stale sources or change qualification. Reusable requirement corrections bind the
exact assessment, Profile source version, canonical revision and literal permitted
evidence. Direct demands do not use the canonical correction endpoint. Old
contract scores cannot be corrected into new authority. No-score records cannot
receive a numerical correction.

Minimum-fit readiness reads the live versioned setting without recomputing any
score. It requires a current numerical score. Legacy-contract and unsupported-
language scores are excluded from active Digest match sets and keyword labels;
their original values remain in history and the stale-job inventory.

## Approved wording and section support

Qualification is independent of wording and document selection. A supported
Skills/Experience item with `wording_support: section` appears in coverage's
`section_support` with exact assessment/evidence IDs. It creates no achievement
wording gap, makes no wording/authoring call, and supplies no achievement-selection
objective. Direct Education/Language demands are absent from coverage altogether.

For achievement-backed reusable support, `Coverage.refresh` reuses exact current
relations and maintained assignments first. It considers an achievement's complete
currently supported reusable set and approved variants together in one grouped
expression decision. Already covered requirements and stylistic variation cannot
justify new wording. One exact approved wording can serve several requirements;
multiple maintained variants require a recorded source-bound exception. Profile
alone proposes text, and only an explicit user action approves it.

Relations bind canonical revision, accepted qualification, achievement, exact
variant revision/text fingerprint, approval and source versions. Revalidation
follows literal recorded ancestry and retains original semantic authority.
Historical authoring intent cannot force achievement wording for an item now
supported by a section. Consolidation preserves every current achievement wording
objective; accepted section support remains separate.

Pending, rejected, deferred, failed and uncertain requests are retained and
deduplicated across equivalent jobs. An explicit retry targets the exact failed
proposal, current grouped sources and approved inventory. Old-contract authoring
metadata cannot be resurrected. A failed model/coverage/authoring refresh retains
the last accepted qualification, wording assignments and artifact bytes.
`prepare_coverage=False` runs no expression work; `prepare_wording=False` permits
coverage assessment while suppressing authoring proposals.

## Manual bounded refresh

`fit.refresh` is manually admitted with an exact pending-input fingerprint,
selected saved jobs and persisted call/item/wording/deadline limits. The operation
freezes the complete active reusable catalog, the selected jobs' direct demands,
Profile sources and guidance, prior assessment/source heads, approved wording and
maintained assignments. Unselected jobs' direct demands never expand its scope.

Manual refresh accepts `prepare_coverage` (strict boolean, default `true`). Set
both `prepare_coverage: false` and `prepare_wording: false` to publish only factual
qualification and deterministic scores, then complete without coverage or
authoring calls. Wording retries cannot be selected with coverage disabled.
The chosen flags remain frozen in operation state and visible in operation reads.
Missing flags in previously frozen state preserve coverage's existing enabled
behavior; omitted or explicit `true` does not change the existing request hash.

The complete frozen inventory is accounted for before impact request construction.
Each exact current qualification is retained unchanged. Items whose exact
dependencies already require reassessment use the existing mandatory-affected
rule. One source-bound impact determination partitions only the remaining
uncertain changed-fact items, including previously unsupported meanings that new
facts may support. It receives all current factual sources and each included
item's own prior baseline; resolved rows are not retransmitted. No lexical rule
decides whether changed facts affect support. Exact-current assessments stay
unchanged with no new impact receipt. Only a source-changed judgment the model
marks unchanged receives an explicit impact receipt and revalidation lineage
while retaining its original semantic authority.
Every pending selected item enters one qualification batch; the complete map is
checkpointed before individual rows. Publication updates only selected job scores.

When every frozen prior assessment is absent, all items require initial
qualification structurally. That case skips the impact model call, records
`initial_qualification` with structural `all_prior_assessment_ids_absent`
provenance and no fabricated selection receipt, then makes the one complete
qualification batch. Item/call/deadline limits, cancellation and source/head
guards still apply. Mixed sets record fixed structural authority separately from
the original model-subset decision/receipt and a fingerprinted complete partition.
Only actual impact and qualification calls consume model-call reservations.

New operations pin `impact_selection_scope_version` and independently pin
`qualification_transport_version`. An older operation keeps its exact original
impact request/call key, including a completed call without a selection checkpoint.
For qualification call-only recovery, the frozen inputs reconstruct the exact
historical inline and permission-scoped request keys. Exactly one retained match
reuses its original raw result or retains an unsettled-call refusal; mismatched or
conflicting calls cannot obtain another allowance. A recovered inline receipt
does not acquire scoped transport provenance. With no retained qualification
call, the current transport is atomically pinned before its first reservation.
Existing batch checkpoints, qualification versions and accepted currentness stay
unchanged. These wire pins are per operation, not a global semantic invalidation.

A new manual qualification stores the exact gateway receipt ID, request
fingerprint and non-secret execution identity in the transaction that admits
the provider call. If the frozen workspace changes after the provider returns,
the original operation retains its source conflict and publishes no score.
A separately admitted manual refresh for the same Profile and selected jobs
may adopt the one settled qualification receipt for its exact source arguments,
schema, prompt, provider, model, effort and configuration. The earlier manual
operation must have reached qualification and encountered a revision conflict
before factual publication. A historical completed call supplies its saved
gateway receipt. A historical started call has only its original argument key.
In that case the gateway must show one qualification admitted and settled
strictly within that stale operation's lifetime, with an exact matching input.
A matching receipt from before the stale operation cannot serve as its witness.
Ambiguous admissions, unresolved timestamp boundaries, multiple eligible
receipts and unsettled calls refuse adoption.
A previous cancellation or provider failure cannot supply a reused decision.
An explicitly requested retry of a settled failed call still undergoes normal
admission. A known outstanding or uncertain effect prevents another exact
dispatch.
The current operation verifies the complete returned partition, citations,
permitted facts, achievements and source heads before publishing its score.
Operation counters record one `qualification_receipts_reused` for an adoption.
`model_calls` counts new external calls. Historical operations preserve their
original checkpoint and interruption behavior.

Reservations precede external I/O and counters/checkpoints survive restart. A lost
external acknowledgement cannot spend a fresh allowance. Input/catalog/posting/
assignment changes refuse stale completion; cancellation and failures preserve
accepted results. Factual publication and later expression failure are reported
separately. Ordinary gateway lane/workspace spend preflight still applies; work
limits are not a guaranteed monetary maximum. Reads, saves, approval and the
refresh's own writes admit no additional work or cascades.

## Public surfaces and adapter boundary

HTTP, CLI and durable actions call the same `FitService`; `bootstrap.build_feature`
constructs the SQLite adapter and injects its feature-owned store port. The
feature reads public Profile/Requirements snapshots, never sibling private tables.
Canonical writes and bounded invalidation events commit in one SQLite transaction.

- Jobs: `GET /v1/jobs/{id}/fit`, `/fit/history`, `/fit/coverage`; explicit
  `/fit/assess`, `/fit/correct` and `/fit/coverage/refresh` actions.
- Library: `GET /v1/fit/requirement-library` returns the active reusable catalog,
  recorded current/stale assessments, exact relations and maintained assignments.
  Before Profile exists it remains readable as `readiness: profile_required`.
  Requirements' `library_catalog_snapshot` supplies membership from accepted
  occurrences on existing nondeleted Jobs. Hidden Jobs count; deleting the last
  live occurrence removes the row even when stored support or user links exist.
  Those records remain retained and return under the same identities when a Job
  is restored. Complete-catalog matching and manual refresh keep using the
  separate retained `catalog_snapshot`; library reads admit no model work.
  When Requirements permanently removes an orphaned meaning, its registered
  deletion port removes Fit's assessment/coverage/request rows, user association
  heads/history and maintained selection heads/history in the same Jobs write
  transaction. Profile facts and approved wording stay unchanged; historical
  wording provenance and immutable group/model receipts remain audit records.
  Grouped wording requests are pruned by member identity, not their first-member
  SQL index: surviving members retain the original proposal/origin, revision and
  evidence pins, with gap/intended IDs pruned and the leading index updated.
  Only empty groups are removed. A surviving requirement therefore retains its
  rejected/deferred proposal suppression during the next explicit refresh;
  immutable Profile proposal provenance is unchanged.
- User associations: creation/revision/state/history endpoints retain revision-
  bound intent with `origin: user` and `assessment_status: unassessed`. They never
  write qualification, coverage, scores, approval or model work.
- Maintained wording: explicit selection/state/history endpoints bind exact
  current approved wording and positive coverage; assignment history remains
  separate from immutable coverage receipts.
- Audit/composition: evidence-map, bounded bulk summaries, policy, model-supplied
  keyword labels and Digest joins retain recorded identities/currentness.
- Refresh: pending and operation reads are model-free. A manual operation's
  selected job IDs, versions, counters, limits, checkpoints and failure state
  remain inspectable through completion, partial failure or cancellation.

Validation follows `docs/local-reliability-qa.md`: actual public application
journeys in owned synthetic workspaces, controlled only at the external provider
boundary. No labeled semantic corpus, internal replacement service, snapshot test
or recorded-output replay establishes model authority.
