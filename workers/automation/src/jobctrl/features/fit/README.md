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

The reusable catalog contains only `skill` and `professional_experience`.
`education` and `language` are direct, job-local demands. Their namespaced IDs
remain tied to the job/posting and their assessments never enter the reusable
library, wording coverage or authoring. Each direct alternatives group is one
assessment item. Deleting a job removes its direct assessment records together
with its score/operation records; reusable person/requirement authority remains.

`unique_requirements` consumes Requirements' public `snapshot_items` adapter,
which joins reusable occurrences to exact canonical category, name and definition.
The original source-bound extraction, source note and occurrence IDs remain
inspectable. Repeated occurrences of a canonical meaning count once. Source notes
are retained for explanation and do not affect score arithmetic. Unsupported
posting languages receive no replacement score. A prior score remains historical
with `unsupported_posting_language`; an explicit assessment is refused before
qualification work.

## One complete qualification batch

`FitService.assess_job` and `Qualification.resolve_many` inspect the entire fixed
job item set, reuse exact current authority, then submit every pending category
together in one `fit.qualification-batch` determination, prompt
`fit-qualification-batch-v3`, in the existing `scoring` lane. The complete Profile
source inventory is supplied once. Each item has its own `requirement:<id>` source,
category, revision and permitted evidence IDs. There are no chunks, truncated
inventories, lexical judgments, per-item semantic retries or result replay cache.
An all-current set makes zero qualification calls.

The strict response remains `{ requirements: QualificationDecision[] }`. It must
contain every requested ID/revision exactly once. Decisions retain `kind`,
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

One complete source-bound impact determination selects affected items, including
previously unsupported meanings that new facts may support. Exact unaffected
source bindings require no semantic call. Unchanged judgments retain their
original receipt, with an explicit revalidation lineage when sources change.
Every pending selected item enters one qualification batch; the complete map is
checkpointed before individual rows. Publication updates only selected job scores.

When every frozen prior assessment is absent, all items require initial
qualification structurally. That case skips the impact model call, records
`initial_qualification` with structural `all_prior_assessment_ids_absent`
provenance and no fabricated selection receipt, then makes the one complete
qualification batch. Item/call/deadline limits, cancellation and source/head
guards still apply. Mixed or existing assessment sets retain impact selection.

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
