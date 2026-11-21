# Person Fit and Scoring Policy

Fit assesses the person against qualified job requirements. Requirements owns
the meanings and occurrences, Profile owns facts and evidence, and Resumes
owns document choice. This page describes the Python source contract. The
[journey ledger](../developer/qa/python-journeys.md) records observed integration
evidence; source behavior does not establish an installed release or
real-provider judgment quality.

## Typed requirements and permitted evidence

The current source contract is `requirements-v2`. Requirements separates four
categories before Fit or wording work:

| Category | Identity and reuse | Permitted factual evidence |
| --- | --- | --- |
| Skills | Reusable canonical catalog meaning | Structured Profile Skills, factual roles and achievements |
| Professional Experience | Reusable canonical catalog meaning | Factual roles and achievements |
| Education | Direct job-local demand with exact posting revision | Structured Education records; professional experience only for an explicitly offered equivalent-experience alternative |
| Languages | Direct job-local demand with exact posting revision | Structured Language / Proficiency records only |

The model determines support, degree equivalence and proficiency from permitted
sources. Code validates evidence categories, IDs, revisions and exact citations.
An education alternative records the experience route without asserting a
degree. General skills, an achievement, prose in an attachment or a language
named in a Skills group cannot prove language proficiency. Personal traits,
certifications and licenses, job conditions and detailed tenure analysis are
excluded from this iteration. Structured certification support remains separate
in [#1476](https://github.com/ebarti/JobCtrl/issues/1476).

A source-bound language determination precedes requirement extraction. A
non-English posting is skipped; it is neither translated nor assigned zero fit.
An unavailable or invalid determination preserves accepted state. Extraction
retains source excerpts, source-bound notes, meaningful alternatives and source
ambiguities without inventing importance weights, mandatory labels or a row for
every task. An alternatives group represents one demand.

## Requirements catalog matching

Requirements extracts the posting's typed demands, then passes every semantic
publication through one mandatory capability/demand consolidation determination.
It sees the complete retained current-generation catalog, including meanings
hidden by soft-deleted jobs, original source authority, incoming entries and
accepted occurrence bindings. Existing catalog entries are reconciled with one
another as well as with new entries. Ordinary phases, audiences, checks and
outcomes share one capability identity; materially different expertise and
independently demanded named technologies remain distinct. There is no target
count, retrieval subset, catalog paging, chunk loop or separate novelty judge.

The result exhaustively partitions capability members and binds every occurrence
to one combined source-established demand per job/capability. The capability's
core definition is separate from this demand. Equivalent demands reuse an exact
model-normalized signature; different genuine demands do not create extra skill
identities or impose their conditions on other jobs. Original extraction and
exact source evidence remain intact. Education and Languages remain job-local
and absent from this catalog and achievement-wording authoring.

Publication validates complete partitions, source citations, revision/epoch and
all affected accepted snapshot/posting heads. One transaction appends capability
revisions, recorded aliases, the reconciliation certificate and replacement
Requirements snapshots. Historical IDs/revisions remain exact history; alias
navigation never makes their previous assessments current. An uncertain,
incomplete, cancelled, stale or refused result publishes no partial change.
The separately versioned normalization policy fences old operations and
unnormalized accepted snapshots. Explicit existing-only repair uses the same
gate; ordinary reads perform no model work.

Extraction's quote-selection model wire selects exact source IDs and unique verbatim quotes.
Requirements derives their numeric character ranges from the frozen posting;
missing, foreign or repeated quotes fail without fuzzy matching or another
model call. The canonical/manual Span contract remains numeric. Raw selections
stay identical to their immutable model receipt and cache entry; normalization
is pure validation, and the service uses the canonical spans only after that
verified boundary succeeds.

Extraction identifies its semantic source by a fingerprint of the complete,
exact posting text. Matching additionally binds the full incoming typed
inventory and current catalog. Job IDs, posting revisions and observation times
are publication identity, not additional semantic input. Identical semantic
inputs may therefore reuse a verified Requirements receipt across postings;
similar or normalized text cannot. Each destination still publishes its own
occurrences under its actual posting/source IDs, revisions and hash. A separate
`source_binding` records the content source and destination posting without
rewriting the immutable model response or claiming another provider call.

An exact-call lookup and any resulting call share one frozen execution
descriptor: provider/model, effective reasoning effort and the digest of
allowlisted nonsecret provider configuration. Prompt/schema versions, complete
sources and context also participate in the fingerprint. Budget admission and
credentials remain live at their owning boundaries. A missing feature-cache row
can recover a succeeded gateway receipt only through the same exact identity,
strict result/citation validation and publication guards. There is no blanket
gateway result cache. An explicit forced refresh has its own durable action
binding; retries of that same action may reuse its settled result.

Single-job refresh encodes repeated whole source values and citation paths in
request-local dictionaries. The owner restores and verifies the full source
inventory, then checks every model-selected reuse ID against the assigned
retained meaning and exact definition. Newly admitted searches freeze this
transport choice before any target is processed.

The complete serialized input must pass the gateway's structural payload limit
and lane/spend admission. A byte bound does not prove token-context fit; the
current gateway has no selected-model context-capacity metadata. Input/context
or provider refusal preserves accepted state and never falls back to chunks.
A concurrent catalog publication fences a stale result and requires a fresh
whole-catalog determination, within the refresh's bounded work allowance.
Catalog writes do not automatically schedule Fit reassessment. The feature
[reference](../../workers/automation/src/jobctrl/features/requirements/README.md)
owns the exact schema, cache and failure contracts.

Manual Fit work captures Requirements' public `catalog_snapshot(connection)`
inside its source-read transaction. The snapshot contains the complete sorted
canonical ID/revision inventory, categories, names, definitions, catalog epoch
and semantic fingerprint. Its publication transaction calls the public
`assert_current_catalog(snapshot, connection)` guard; any catalog change refuses
the captured operation instead of expanding its work. Fit never reads
Requirements' private tables to assemble or validate that inventory.

## Inputs and semantic authority

Fit first resolves accepted person qualifications for the complete job
requirement set, including direct Education and Languages demands. Reuse of
catalog qualification is keyed by Profile ID, canonical capability ID/revision,
the normalized job-demand fingerprint, permitted factual sources and the
qualification semantic/prompt version. The canonical capability definition alone
cannot substitute for the demand being assessed. Identical current demands can
reuse accepted authority across jobs; genuinely different demands cannot reuse
one another's assessment. Changing only model selection does not manufacture
new authority. If every qualification is current, this stage makes zero model
calls. A job with no prior score may resolve its fixed requirement set during
explicitly authorized initial preparation, including new current authority where
older shared qualifications predate saved changes. Publication compares the
captured current-source and historical heads, rechecks that the job has no
score and preserves history; it rewrites no other
job's score. Updating qualification for a previously scored job after saved-input
changes still requires explicit manual refresh. Saves start neither operation.

Normalization's separately versioned response transport does not itself change
capability/demand semantics or these qualification pins. Required member and
occurrence slots record explicit root/same-as/unresolved choices for every input.
Raw slot authority, the grouping derived from recorded identity joins and exact
source-reference quote display keep distinct versioned bindings and fingerprints.
A projection cannot replace the model's recorded decision or resolve uncertainty.

The entire missing set across all four categories enters one
`fit.qualification-batch` request in the scoring lane, with the complete factual inventory supplied once and a distinct
source for each exact capability/demand binding. There is no per-requirement call
loop, chunking, truncation or lexical fallback. The response must partition the
exact requested IDs, revisions and demand fingerprints once each. Each row must cite its own
requirement; no requirement can prove a candidate fact or substitute for another
row's meaning. All rows pass schema, evidence and immutable gateway-receipt
validation before the new assessments publish together in one transaction.
Direct demands also bind their job-local identities, exact posting source and
revision. They cannot reuse another job's qualification or gain reusable catalog
identity from similar fields.

The `fit-permission-scopes-v1` context transport shares only identical ordered
permission-ID lists. Each row references a defined scope; inverse expansion must
reproduce its canonical context exactly, with every factual source, category and
alternative retained. Opaque provenance records the transport version,
context/source/scope hashes and counts. The encoded-context hash excludes its own
binding. This version changes model request identity, while the v4 qualification
prompt policy, source fingerprints, output schema and currentness checks remain
unchanged. Accepted v4 authority stays reusable without a refresh.

Each accepted row keeps its own assessment identity and canonical revision.
Its demand fingerprint and qualification policy remain explicit. All lookup,
head, replay and publication guards use that same demand binding; adding a hash
only to the initial cache lookup would not establish safe reuse.
Rows share the batch determination/receipt ID and
`provenance.accepted_result_fingerprint` for the complete raw result;
`provenance.qualification_result_fingerprint` separately identifies the exact
row. Publication rechecks sources, accepted heads and cancellation. The score's
existing final guards remain separate. Invalid, stale, refused or cancelled
work preserves accepted assessments and scores. Batching does not change the
configured provider/model/effort policy.

Person qualification is separate from Fit's recorded requirement-to-approved-
wording coverage relations. An unexpressed or unapproved wording is a document
gap and does not reduce factual fit. Profile alone owns the words and approval;
Resumes consumes the recorded coverage for composition.
A current match backed by Profile Skills, Education or Languages is not an
achievement-wording gap. Reuse existing approved expression. New achievement
wording requires an actual unsupported expression need and factual achievement
support; stylistic variation alone cannot authorize a rewrite.

## Requirements Library And User Intent

The independent library composes Requirements' current canonical Skills and
Professional Experience meanings, Profile's immutable achievement/wording snapshots and Fit's recorded assessments
and exact coverage. It groups by achievement identity and shows original posting
occurrences separately. Missing or stale relationships remain explicit.
One capability can have several source-established demands. The library exposes
their assessments separately. **Profile match** reports assessment currentness
before outcomes: Not assessed, Needs update for earlier-only assessments, or
Partially assessed for mixed currentness. When all demands have current
assessments, it reports the shared outcome or **Varies by job** for different
outcomes, without choosing the strongest/latest assessment. Demand count is
separate context. Recorded achievement relationships include retained historical
records, with earlier-only contributions marked for review; they grant no current
support or approval. A missing or stale demand remains visible. Exact
wording coverage binds its demand and assessment, not merely their shared model
batch receipt. A common maintained variant may retain multiple demand bindings;
uncovered demands stay explicit gaps without automatic editorial alternatives.

Fit also owns revisioned manual associations between a requirement, achievement
and optional exact wording. They retain their original meaning/source/wording
pins and `origin: user`, `assessment_status: unassessed`. Remove/restore retains
history and staleness. These records never become qualification, coverage,
approval or a score and never dispatch a refresh. A stale binding is not repaired
by matching labels or text. Readers join recorded IDs through the public
[library/association API](../api/jobs-and-materials.md#requirements-library-and-associations).

The 11 November owner correction keeps one maintained current wording for an
achievement serving one requirement. Proposed revisions and historical wording
are separate from current maintained assignments. Additional maintained wording
requires distinct coverage that cannot reuse/consolidate existing wording;
canonical requirement names provide its label. Only recorded source-bound
coverage authority can establish that distinction. Manual intended-requirement
metadata and exact wording approval do not manufacture it. See the
[decision](../decisions.md#_2026-11-11-requirement-led-current-wording-and-proposed-revisions)
and [redesign acceptance](../plans/2026-11-11-original-app-redesign.md).

## Profile Edits And Explicit Refresh

Saving Profile facts, sources, wording, approvals or requirement definitions
does not schedule assessment, authoring or resume regeneration. The manual
`fit.refresh` action uses the last saved inputs. A read-only pending summary
supplies the expected input fingerprint; the action refuses if those reviewed
inputs change while it is queued. Before a Profile exists, that passive read
returns `readiness: profile_required` without a fingerprint or currentness
claim. Jobs remain usable, and refreshing matches requires saving a Profile.
It freezes the complete catalog, factual and
approved-wording inventories, guidance, prior assessments, selected scored jobs
and operation limits. Pending proposal bookkeeping is separate from the
approved inventory, so the operation does not invalidate itself.
The frozen inputs and checkpoints also include the selected jobs' direct
Education and Languages demands. They remain job-local throughout impact,
qualification, score publication and recovery.

When factual qualification needs review, the complete frozen inventory first
retains exact current qualifications and records enforced mandatory reassessments.
One source-bound `fit.catalog-impact` determination partitions only the unresolved
changed-fact items. It sees all current facts and each included prior assessment's
own before-sources; exact current rows are not retransmitted. Newly added evidence
can support requirements previously missing or unlinked. Missing exact dependencies
require reassessment; literal unchanged dependencies alone cannot prove that new
evidence is irrelevant. The original model-subset result and receipt remain
distinct from the composed complete partition and its structural authority/hash.
There are no per-requirement impact calls. The affected set without completed qualification
checkpoints receives one complete qualification batch. Exact-current rows retain
their existing assessment unchanged and acquire no new impact receipt. Only a
source-changed row judged unchanged by the model retains its original semantic
judgment with the impact receipt and explicit current-source revalidation lineage.
The complete batch map is checkpointed before its
individual requirement checkpoints. One batch consumes one model-call
reservation; affected-item and deadline limits remain unchanged. Batching
cannot expand the admitted operation or grant a new allowance on retry.

Fresh operations freeze independent impact-scope and qualification-transport wire
pins. Pre-pin operations keep the original full impact request. Qualification
call-only recovery reconstructs both exact historical inline and shared-scope
argument keys from frozen inputs and requires one retained match. A completed call
replays its raw result; an unsettled, foreign or conflicting call refuses without
new work. No missing binding is guessed, no call counter resets, and recovered
inline authority receives no fabricated scope provenance. Existing batch
checkpoints and qualification/currentness versions remain compatible.

Candidates publish atomically after checking Profile, guidance, the complete
catalog, selected job/posting snapshots and prior assessment/score heads.
Concurrent input changes refuse the captured operation instead of widening it.
One active admission per profile includes queued work. Durable call reservations,
completed checkpoints, item counts and a deadline survive worker retries; an
external call with an uncertain result does not silently receive a fresh budget.
Cancellation also seals the feature receipt through the application lifecycle.
Lane and workspace spend admission remains in the model gateway; these work
limits do not guarantee a hard external monetary charge ceiling.

Coverage directly reuses exact current maintained assignments. An absent mapping,
explicit approved revision or consolidation need still requires bounded grouped
selection during admitted work, even if historical coverage relations exist for
every requirement. The group joins supported retained catalog bindings with the
affected subset; it cannot drop an already served requirement merely because
that requirement was outside the new affected subset.

One source-bound group decision can reuse approved text for the group, choose
separate exact relations with cited distinct-coverage rationale, propose new
wording or propose consolidation. Consolidation names at least two explicit
existing replacements and preserves the full group until exact approval,
positive coverage and atomic activation are recorded. Approval alone changes no
Fit assignment. A new proposal never approves itself or triggers another refresh.
If expression preparation fails after factual publication, the operation reports
that partial boundary explicitly; the factual result remains independent of
wording. User corrections retain history and exact source/revision authority.

Manual refresh also freezes maintained assignment heads and their fingerprint
at admission. Its own accepted writes advance that captured fingerprint;
unrelated concurrent edits refuse rather than silently widening the operation.
An unchanged choice revalidated through a recorded literal ancestor can be
repinned without another grouped semantic call. Such structural reuse does not
infer equivalent meaning from new text.

## Deterministic Score Resolution

`features/fit/domain.py` implements `requirement-fit-v3-equal` over the accepted
typed assessments. Every distinct canonical Skills/Professional Experience
meaning and every distinct job-local Education/Languages demand contributes
one item. Duplicate occurrences do not multiply a canonical item's contribution;
an alternatives group is one demand.

Direct support earns `1.0`, strong support `0.85`, transferable support `0.6`,
and missing or blocked support zero. For an assessed set of size `N > 0`:

```text
qualification coverage = sum(evidence credits) / N
score = clamp(1 + floor(9 * qualification coverage + 0.5), 1, 10)
```

For `N = 0`, no score is calculated. Persist formula version, assessed count
and qualification coverage. There are no source importance weights, must-have
multipliers, blocker caps or invented source priorities. Source notes do not
affect arithmetic. An invalid or incomplete set cannot publish a replacement
score, and no opaque dimension-score fallback exists. Confidence, warnings and
downstream eligibility remain separate. The live minimum-fit setting affects
selection, not the calculation or source evidence.

## Generation, history and rollout

`contract_version: requirements-v2` travels through snapshots, occurrences,
assessments, scores, operations, model identities, publication guards and
currentness checks. A missing version denotes legacy state. Existing SQL schema
strings stay byte-identical; the application checks their digest. Current
canonical IDs are namespaced, the active catalog starts empty, and current
readers do not promote legacy meanings because their fields look compatible.

Historical accepted rows, job revision ordering and accepted resume bytes remain
available. Older results require refresh for the changed contract and cannot
prove current ranking or composition readiness. Incompatible operation
resumption/replay is refused. A replacement moves accepted pointers only after
successful publication; failure, cancellation or stale inputs preserve the last
accepted state.

An operational rollout must stop old writers and back up the workspace before
new-generation writes. Rollback after such writes restores that backup; merely
installing an older binary is unsafe. This implementation work establishes no
live rollout. See the [typed-requirements plan](../plans/typed-requirements.md)
and [backup boundary](../user/data-and-safety.md#typed-requirements-upgrade).

## Corrections, policy and reads

A score correction records a new user-authoritative score version and rationale
while retaining the calculated score and underlying evidence. A qualification
correction is independently source- and revision-bound. Changing either must
not silently rewrite prior artifacts or acceptance decisions.

The adapter declares `GET /v1/jobs/{job_id}/fit`,
`/fit/history`, `/fit/coverage`, and explicit assessment/correction/coverage
commands, plus `/v1/fit/evidence-map`. Exact request fields live in
`features/fit/http.py`; route declarations alone do not prove an integrated
journey. Fit consumes public Profile and Requirements services and publishes
bounded IDs and revisions, not private evidence, in events.

The Fit grid, detail and attention reads share the accepted-score currentness
rule. Evidence is compared using the criteria recorded on the score. Demand
comparison first checks the accepted normalized job demands and direct criteria.
When consolidation changes the groups, Requirements compares the exact source
snapshot used by the score with the accepted snapshot. A verified regrouping of
the same extracted demands keeps the saved score current. Preparation and
application work also checks the grouped qualifications and posting source.

## Selected-cohort comparison stays outside scoring

Selected job demand and Learning milestones are separate observations with their
own source and user action. A saved activity, aspiration or posting demand does
not establish a capability, raise readiness or modify person fit. See
[tailoring](tailoring.md) and [QA journeys](../developer/qa/python-journeys.md).
