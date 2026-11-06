# Person Fit and Scoring Policy

Fit assesses the person against qualified job requirements. Requirements owns
the meanings and occurrences, Profile owns facts and evidence, and Resumes
owns document choice. The Python transformation is **in progress**; the source
contract below must still be verified in the integrated product and does not
assert real-provider judgment quality.

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

Saving Profile does not itself schedule a score. An explicit Fit refresh
compares source versions and uses a source-bound impact determination to decide
which recorded requirement assessments remain applicable. It reuses unchanged
semantic receipts with current-source revalidation and reassesses affected
requirements. Source changes during inference or a failed impact determination
must not overwrite the accepted score. User corrections create history and are
bound to the exact requirement, source and revision.

## Deterministic Score Resolution

The in-progress `features/fit/domain.py` implements the versioned
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

The current work-in-progress adapter declares `GET /v1/jobs/{job_id}/fit`,
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
