# Scoring

Scoring compares Discovery's canonical, evidence-linked employer analysis with
a versioned Candidate Profile. It produces an applicant-side fit score,
confidence, blockers, gaps, and requirement-level evidence for your own triage.
Discovery owns how the employer analysis is generated and which perspectives
participate; this page owns how that accepted input becomes a fit decision.

## What You Can See And Control

Scoring runs inside Discover preparation. Review it on the current product
surfaces rather than looking for a separate scoring page:

- `/jobs` exposes fit-score filters, sorting, bands, and stage state.
- `/jobs/:jobId` shows the employer analysis, score breakdown, confidence,
  hard blockers, matched/missing/transferable signals, requirement-fit report,
  policy metadata, correction history, and stale state when recorded.
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
- **Operations owns display projections.** Jobs reads expose persisted analysis
  and score evidence. They do not call a model or recompute a score on request.

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
| HTTP contract | Jobs list/detail reads, `POST /v1/jobs/:key/score-correction`, per-job current-policy re-score, and bulk/stale-score actions; see [Jobs & Materials API](../api/jobs-and-materials.md#jobs-and-evidence) and the [complete lifecycle contract](../api/complete-contract.md#jobs-read-model-and-lifecycle). |
| Worker implementation | `workers/automation/src/jobctrl/scoring/` (`employer_analysis.py`, `scorer.py`) and `workers/automation/src/jobctrl/domain/scoring/`; canonical analysis gates and persistence live under `workers/automation/src/jobctrl/domain/materials/analysis*` and `workers/automation/src/jobctrl/infrastructure/materials/employer_analysis_repository.py`. |
| Product components | `apps/web/src/contexts/scoring/`, `apps/web/src/contexts/materials/components/EmployerAnalysisPanel.tsx`, and the Jobs detail/triage views. |
| Deep architecture | [Scoring](../architecture/scoring.md), [Materials → Canonical Employer Analysis](../architecture/materials.md#canonical-employer-analysis), and [Stage Walkthrough → Score](../architecture/pipeline/stages.md#score). |
