# Person Fit and Scoring Policy

Fit assesses the person against qualified job requirements. Requirements owns
the meanings and occurrences, Profile owns facts and evidence, and Resumes
owns document choice. This page describes the Python source contract. The
[journey ledger](../developer/qa/python-journeys.md) records observed integration
evidence; source behavior does not establish an installed release or
real-provider judgment quality.

## Requirements catalog matching

Requirements extracts the complete posting inventory, then sends that entire
incoming batch and every current canonical catalog definition, scope and
qualifier to one source-bound matching determination. The same response decides
equivalence, genuine novelty or uncertainty. Incoming paraphrases share an
explicitly selected representative; each posting occurrence remains recorded.
There are no retrieval subsets, catalog pages, chunk loops or separate novelty
judge. Citations, full incoming-ID cardinality, exact canonical revisions and
the catalog epoch are validated before an atomic publication.

Extraction's quote-selection model wire selects exact source IDs and unique verbatim quotes.
Requirements derives their numeric character ranges from the frozen posting;
missing, foreign or repeated quotes fail without fuzzy matching or another
model call. The canonical/manual Span contract remains numeric. Raw selections
stay identical to their immutable model receipt and cache entry; normalization
is pure validation, and the service uses the canonical spans only after that
verified boundary succeeds.

Extraction identifies its semantic source by a fingerprint of the complete,
exact posting text. Matching additionally binds the full incoming qualified
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
canonical ID/revision inventory, definitions, qualifiers, scopes, catalog epoch
and semantic fingerprint. Its publication transaction calls the public
`assert_current_catalog(snapshot, connection)` guard; any catalog change refuses
the captured operation instead of expanding its work. Fit never reads
Requirements' private tables to assemble or validate that inventory.

## Inputs and semantic authority

Fit first resolves accepted person qualifications for the complete job
requirement set. Reuse is keyed by Profile ID, canonical requirement ID and
revision, and the complete factual source/achievement fingerprint. An accepted
qualification retains its original model or user authority across jobs; a new
posting occurrence, priority or model selection does not manufacture a new
assessment. If every qualification is current, this stage makes zero model
calls. A job with no prior score may resolve its fixed requirement set during
explicitly authorized initial preparation, including new current authority where
older shared qualifications predate saved changes. Publication compares the
captured current-source and historical heads, rechecks that the job has no
score and preserves history; it rewrites no other
job's score. Updating qualification for a previously scored job after saved-input
changes still requires explicit manual refresh. Saves start neither operation.

The entire missing set enters one `fit.qualification-batch` request in the
scoring lane, with the complete factual inventory supplied once and a distinct
`requirement:<id>` source for each meaning. There is no per-requirement call
loop, chunking, truncation or lexical fallback. The response must partition the
exact requested IDs and revisions once each. Each row must cite its own
requirement; no requirement can prove a candidate fact or substitute for another
row's meaning. All rows pass schema, evidence and immutable gateway-receipt
validation before the new assessments publish together in one transaction.

Each accepted row keeps its own assessment identity and canonical revision.
Rows share the batch determination/receipt ID and
`provenance.accepted_result_fingerprint` for the complete raw result;
`provenance.qualification_result_fingerprint` separately identifies the exact
row. Publication rechecks sources, accepted heads and cancellation. The score's
existing final guards remain separate. Invalid, stale, refused or cancelled
work preserves accepted assessments and scores. Provider/model/effort policy
and scoring arithmetic are unchanged by batching.

Person qualification is separate from Fit's recorded requirement-to-approved-
wording coverage relations. An unexpressed or unapproved wording is a document
gap and does not reduce factual fit. Profile alone owns the words and approval;
Resumes consumes the recorded coverage for composition.

## Requirements Library And User Intent

The independent library composes Requirements' current canonical meanings,
Profile's immutable achievement/wording snapshots and Fit's recorded assessments
and exact coverage. It groups by achievement identity and shows original posting
occurrences separately. Missing or stale relationships remain explicit.

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

When factual qualification needs review, one source-bound `fit.catalog-impact`
determination partitions the complete catalog into affected and unchanged
requirements. It sees each prior assessment's own before-sources and the current
facts. Newly added evidence can support requirements previously missing or
unlinked. Missing exact dependencies require reassessment; literal unchanged
dependencies alone cannot prove that new evidence is irrelevant. There are no
per-requirement impact calls. The affected set without completed qualification
checkpoints receives one complete qualification batch; unaffected decisions
retain original semantic authority with a shared impact receipt and
current-source revalidation. The complete batch map is checkpointed before its
individual requirement checkpoints. One batch consumes one model-call
reservation; affected-item and deadline limits remain unchanged. Batching
cannot expand the admitted operation or grant a new allowance on retry.

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

`features/fit/domain.py` implements the versioned
`requirement-fit-v2-scoped` arithmetic over qualified capability assessments:

1. For each resume-capability requirement, maximum points are its weight times
   `1.25` for a must-have or `1.0` for a nice-to-have.
2. Direct support earns `1.0`, strong support `0.85`, transferable support
   `0.6`, and missing or blocked support zero. Row contributions are rounded to
   four decimals before totals are combined.
3. `weighted_fit = sum(awarded) / sum(maximum)` and the score is
   `1 + floor(9 * weighted_fit + 0.5)`, clamped to 1–10. A capability blocker
   caps the score at 4.

Eligibility, logistics and employer-condition rows do not contribute points;
blockers, warnings, confidence and unknowns are reported separately. A missing
or incoherent set of weighted capability requirements cannot be replaced by a
legacy opaque dimension score. The live minimum-fit setting affects selection,
not the calculation or the person's source evidence. Compensation and other
preferences remain warnings where applicable, not invented qualifications.

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

## Selected-cohort comparison stays outside scoring

Selected job demand and Learning milestones are separate observations with their
own source and user action. A saved activity, aspiration or posting demand does
not establish a capability, raise readiness or modify person fit. See
[tailoring](tailoring.md) and [QA journeys](../developer/qa/python-journeys.md).
