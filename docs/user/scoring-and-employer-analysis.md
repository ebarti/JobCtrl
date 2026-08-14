---
description: "See how JobCtrl scores job fit from versioned profile evidence, requirement-level assessments, blockers, confidence, and correction history."
---

# Scoring

Scoring compares Discovery's canonical, evidence-linked employer analysis with
a versioned Candidate Profile. It produces an applicant-side fit score,
confidence, blockers, gaps, and requirement-level evidence for your own triage.
Discovery owns how the employer analysis is generated and which perspectives
participate; this page owns how that accepted input becomes a fit decision.
For a shorter conceptual introduction, read
[Evidence-based Job Fit Scoring](../guides/evidence-based-job-fit-scoring.md).

## How The Score Is Calculated

JobCtrl does not ask a model for one opaque number and save it. The model
classifies the evidence for each posting requirement; versioned, deterministic
code turns those classifications into the persisted 1–10 score.

When Discovery supplies explicit requirements, the calculation works like
this:

1. **Send the accepted requirements to the scorer.** The scoring request
   includes each requirement's ID, posting text and evidence, priority weight
   from 0 to 1, and tier: must-have or nice-to-have. The structured scorer
   returns those fields with its assessment.
2. **Classify the returned evidence.** A matched or transferable row must carry
   at least one non-empty Candidate Profile evidence ID. The current parser
   checks that an ID is present, but it does not yet verify that every returned
   ID exists in the saved profile or reconcile every returned requirement
   field with the accepted analysis. The formula therefore resolves the
   scorer's validated structured response; inspect the evidence links, and
   treat any **Unavailable evidence** label as a reason to correct or re-score.
3. **Apply evidence credit and requirement priority.** The current
   `requirement-fit-v1` formula uses these values:

   | Evidence classification | Credit |
   | --- | ---: |
   | Direct match | 100% |
   | Strong match | 85% |
   | Transferable evidence | 60% |
   | Missing, blocked, or not assessed | 0% |

   A must-have requirement counts **1.25×** its saved weight; a nice-to-have
   counts **1.0×**. JobCtrl then calculates weighted coverage and maps it to the
   1–10 scale:

   ```text
   adjusted weight = requirement weight × tier multiplier
   coverage = sum(adjusted weight × evidence credit) / sum(adjusted weight)
   score = 1 + round(9 × coverage)
   ```

   Each row's adjusted weight and awarded points are rounded to four decimal
   places before JobCtrl totals them.

   Rounding is to the nearest whole number, with halves rounded up, and the
   result is limited to 1–10. If any requirement is classified as blocked, the
   final score is capped at 4 after the weighted calculation.
4. **Assign the display band.** Scores 9–10 are **Excellent**, 7–8 **Strong**,
   5–6 **Plausible**, 3–4 **Stretch**, and 1–2 **Poor**.

For example, suppose a must-have with weight `1.0` is a direct match and a
nice-to-have with weight `0.5` has transferable evidence:

| Requirement | Adjusted weight | Credit | Awarded points |
| --- | ---: | ---: | ---: |
| Must-have, direct match | 1.25 | 100% | 1.25 |
| Nice-to-have, transferable | 0.50 | 60% | 0.30 |

Coverage is `1.55 / 1.75 = 0.886`, so the score is
`1 + round(9 × 0.886) = 9`: **Excellent**. The Job Detail requirement report
shows the persisted assessment, evidence links, and contribution for every
row. Resolved profile evidence is the support you can audit; an unavailable
reference is not proof of a match.

### When Requirement Rows Are Unavailable

The requirement-led formula runs only when the scorer returns at least one
valid requirement-assessment row for the current employer-analysis generation.
Otherwise JobCtrl uses its versioned compatibility rubric: **45% technical
fit, 30% experience fit, and 25% role fit**. It takes the weighted average of
those three 0–10 values, rounds halves up, clamps the final score to 1–10, and
applies the same score bands.

### Score, Confidence, And Eligibility Are Different

- **Confidence is a review signal, not a points adjustment.** Low confidence
  tells you to inspect the evidence; it does not automatically lower the score.
- **Eligibility is recorded separately from soft fit.** A blocked requirement
  caps requirement-led scoring at 4, while hard eligibility blockers can also
  prevent downstream tailoring. Warnings and eligibility are not added as a
  generic points penalty.
- **Compensation preferences never block tailoring.** A posted salary below
  your preferred range remains visible as an auditable warning, including the
  parsed amount and source, while the job continues through materials.
- **The minimum-fit threshold does not change the saved score.** It decides
  whether an existing score is eligible for materials. Changing it does not
  call the model or recalculate the score. A below-threshold decision is shown
  on Tailor, Cover, and Apply as `skipped` with `MIN_SCORE` and the exact
  score/threshold pair; it is not pending work or a generation failure.
- **A correction is not a hidden weight change.** Your correction creates a new
  reviewed score version and a calibration anchor. An explicit re-score runs
  the current policy again against the current canonical inputs.

### Indexed Scoring Keywords

Each score version stores its keywords in a normalized, indexed relation keyed
by tenant, job, and score version. Historical versions remain auditable, but
Jobs filtering and `GET /v1/scoring/keywords` use only the score version that
the current projection renders. The aggregation returns both the canonical
normalized key and a display spelling with its score version and job count.

`GET /v1/jobs?normalizedScoreKeyword=...` accepts the exact canonical key from
that aggregation. Normalization is owned by persistence, including Unicode
case-folding; clients do not guess or re-normalize display text.

## What You Can See And Control

Scoring runs inside Discover preparation. Review it on the current product
surfaces rather than looking for a separate scoring page:

- `/jobs` exposes fit-score filters, sorting, bands, and stage state.
- `/jobs/:jobId` shows the employer analysis, score breakdown, confidence,
  hard blockers, matched/missing/transferable signals, requirement-fit report,
  policy metadata, correction history, and stale state when recorded. Profile
  evidence attached to a requirement resolves through the Evidence map into its
  title and a useful source excerpt; unresolved references are labeled
  unavailable, with the raw storage key kept under **Technical details**.
- `/evidence-map` works in the opposite direction: it shows where a profile
  achievement or skill was used by requirement-fit and generated materials.
- `/settings` owns scoring and target guidance. Guidance influences subsequent
  scoring work but is not candidate evidence.
- `/settings/models` selects employer-analysis perspectives. Their execution,
  failure, and fallback behavior belongs to
  [Discovery](discovery.md#employer-analysis-perspectives).
- `/discovery` owns the minimum-fit eligibility threshold. Changing that
  threshold can make persisted scores eligible or ineligible for materials; it
  does not rewrite the score or call the scoring model again.

From the Job Detail workspace you can record a corrected score with a rationale
or ask for an explicit re-score against the current policy. The Jobs toolbar also
offers bounded current-policy maintenance for selected or outdated scores.
A correction and a re-score are different: correction records your reviewed
decision; re-score runs the current scoring pipeline and creates a new model-
derived version.

Low confidence means the evidence needs review, not that the fit is necessarily
low. A high score with evidence you cannot personally support is likewise a
reason to correct or investigate it.

### Scoring priorities {#runtime-setting-scoring-priorities}

**Settings → General → Scoring guidance → Scoring priorities** adds user
guidance describing what strong-fit jobs should demonstrate. It is consumed by
newly started scoring work. It is policy input, not candidate evidence, and it
does not rewrite historical score versions.

### Target role guidance {#runtime-setting-target-role-guidance}

**Target role guidance** adds role or company preferences to newly started
scoring work. It supplements the target-search titles owned by Discovery; it
does not add, remove, or rename those search targets.

## Source Of Truth And Ownership

- **The posting snapshot owns employer claims.** Analysis evidence spans must
  match the captured posting text after formatting-only normalization. A model
  paraphrase is not source evidence.
- **The Candidate Profile owns candidate claims.** Scoring receives an immutable
  profile snapshot; neither analysis nor scoring can add experience or skills.
- **Discovery supplies the canonical requirement reading.** It records role
  framing, requirements, priorities, keywords, posting evidence, synthesis,
  and generation identity. Scoring and Tailoring consume that accepted record;
  its perspective and recovery rules stay in
  [Discovery](discovery.md#employer-analysis-perspectives).
- **Scoring owns the decision record.** Versioned `job_scores` rows hold the
  resolved score, criteria snapshot, requirement-fit evidence, and non-sensitive
  trace. `scoring_policies` owns rubric/policy versions and calibration anchors;
  stale markers record when an older score awaits deliberate adoption of a
  newer policy.
- **Tailoring owns requirement use, not requirement existence.** The accepted
  analysis and requirement-fit report retain every employer requirement.
  Tailoring classifies whether each one is resume-coverable or context-only;
  logistics, eligibility, and employer conditions remain available to fit and
  Apply Review without becoming resume-coverage failures.
- **Operations owns display projections.** Jobs reads expose persisted analysis
  and score evidence. They do not call a model or recompute a score on request.
- **Explicit feedback remains history until an owning policy says otherwise.**
  Score corrections and their anchors are auditable inputs, but Apply candidate
  acquisition does not apply a second feedback-based rank adjustment or let an
  unaccepted learning recommendation reorder jobs.

The model may extract structured evidence and propose fit. The final persisted
decision is resolved through the versioned scoring policy, so a raw model
opinion is not the sole authority. Scores are for a job seeker ranking jobs,
not for an employer ranking people.

## Lifecycle

1. **Start with an enriched posting.** Scoring only consumes the usable job
   record and its captured content.
2. **Preselect work.** Local hybrid retrieval narrows a bounded scoring pool;
   lexical retrieval continues to work when no embedding adapter is enabled.
3. **Consume the accepted employer analysis.** Discovery preparation supplies
   the evidence-linked requirement reading; scoring does not create a parallel
   interpretation of the posting.
4. **Resolve fit.** The scorer combines that analysis, the profile snapshot,
   user guidance, and current policy into structured fit evidence and a policy-
   resolved score.
5. **Persist and project.** The score version, criteria, trace, requirement-fit
   rows, analysis generation, and events are saved before Jobs and Evidence
   projections expose them.
6. **Correct or evolve deliberately.** A user correction creates a new score
   version and a calibration anchor. A new scoring policy can mark comparable
   older scores stale, but it does not silently replace them; an explicit
   re-score adopts the current policy.

## Implementation And API Pointers

| Layer | Pointer |
| --- | --- |
| User workflow | [Daily Workflow → Review Jobs](normal-flows.md) and [Discovery → Employer Analysis Perspectives](discovery.md#employer-analysis-perspectives). |
| HTTP contract | Jobs list/detail reads, `GET /v1/scoring/keywords`, `POST /v1/jobs/:key/score-correction`, per-job current-policy re-score, and bulk/stale-score actions; see [Jobs & Materials API](../api/jobs-and-materials.md#jobs-and-evidence) and the [complete lifecycle contract](../api/complete-contract.md#jobs-read-model-and-lifecycle). |
| Worker implementation | `workers/automation/src/jobctrl/scoring/` (`employer_analysis.py`, `scorer.py`) and `workers/automation/src/jobctrl/domain/scoring/`; canonical analysis gates and persistence live under `workers/automation/src/jobctrl/domain/materials/analysis*` and `workers/automation/src/jobctrl/infrastructure/materials/employer_analysis_repository.py`. |
| Product components | `apps/web/src/contexts/scoring/`, `apps/web/src/contexts/materials/components/EmployerAnalysisPanel.tsx`, and the Jobs detail/triage views. |
| Deep architecture | [Scoring](../architecture/scoring.md), [Materials → Canonical Employer Analysis](../architecture/materials.md#canonical-employer-analysis), and [Stage Walkthrough → Score](../architecture/pipeline/stages.md#score). |
