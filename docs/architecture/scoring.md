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

For each qualified requirement, Fit records a source-bound model determination
or explicit user correction over the relevant Profile facts. Exact source IDs,
revisions and citations establish which evidence was considered; word overlap,
regexes or retrieval rankings do not establish support. Previously accepted
qualification can be reused for the same qualified meaning and unchanged factual
sources across jobs. Failed, invalid or stale determinations do not replace the
last accepted score.

Person qualification is separate from Fit's recorded requirement-to-approved-
wording coverage relations. An unexpressed or unapproved wording is a document
gap and does not reduce factual fit. Profile alone owns the words and approval;
Resumes consumes the recorded coverage for composition.

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
per-requirement impact calls. Affected requirements receive qualification once;
unaffected decisions retain original semantic authority with a shared impact
receipt and current-source revalidation.

Candidates publish atomically after checking Profile, guidance, the complete
catalog, selected job/posting snapshots and prior assessment/score heads.
Concurrent input changes refuse the captured operation instead of widening it.
One active admission per profile includes queued work. Durable call reservations,
completed checkpoints, item counts and a deadline survive worker retries; an
external call with an uncertain result does not silently receive a fresh budget.
Cancellation also seals the feature receipt through the application lifecycle.
Lane and workspace spend admission remains in the model gateway; these work
limits do not guarantee a hard external monetary charge ceiling.

Coverage then directly reuses exact current approved-wording relations and
groups remaining expression work by achievement. One source-bound group decision
considers the relevant requirement set and existing wordings before requesting
new text. A new proposal never approves itself or triggers another refresh.
If expression preparation fails after factual publication, the operation reports
that partial boundary explicitly; the factual result remains independent of
wording. User corrections retain history and exact source/revision authority.

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
