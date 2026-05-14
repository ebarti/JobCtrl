# Job Scoring Intelligence Plan

> **Status:** implemented in PR #61.
> **Research date:** 2026-05-10.
> **Source:** user request to compare current JobHunter scoring against practical job-matching approaches and define the next PR stack.

> **Delivery note:** PR #61 completed the scoring-intelligence stack described
> here. Historical sections below preserve the original plan framing; actual
> delivered outcomes are summarized in `docs/delivered.md`.

## Goal

Move JobHunter scoring from a single opaque LLM-generated fit grade into an explainable, criteria-aware final fit score that is useful for job-seeker triage and safe enough to gate downstream tailoring or apply automation.

## Executive Summary

Current scoring is a solid DDD foundation but an incomplete product signal. The worker now has a `JobScore` aggregate, versioned `job_scores` persistence, structured LLM output, typed dimensions, keyword evidence, and a `CorrectScoreUseCase`. PR 1 exposed the already-persisted score evidence through the API, contracts, and jobs drawer (`scoreBreakdown`, `scoreKeywords`, `scoreVersion`, and `scoredAt`) and hardened blank-keyword parsing. The remaining product gaps are criteria-aware scoring, hard eligibility blockers, score corrections, a local evaluation harness, feedback personalization, and score-governance reporting.

Practical job matching is not done as an opaque LLM grade. The common pattern is hybrid:

- Extract structured candidate and job signals.
- Normalize skills and occupations against a shared taxonomy where possible.
- Score multiple dimensions, including hard constraints and soft preferences.
- Use semantic similarity or embeddings for adjacent/transferable fit.
- Learn from user behavior such as apply, save, dismiss, and corrections.
- Show evidence and missing qualifications, not just a number.
- Evaluate ranking quality offline and monitor it over time.

The recommended direction is to keep the DDD `JobScore` aggregate and still resolve one final score for sorting, filtering, and gating. The change is how that score is produced: expand the scoring language from "score plus reasoning" to "final score backed by a fit assessment": eligibility, weighted dimensions, evidence, gaps, confidence, criteria version, and later correction feedback.

## Current Implementation

### What Works

- Scoring lives in its own bounded context with a `JobScore` aggregate and `ScoreRepository`, matching `docs/ddd-target.md`.
- `ScoreJobUseCase` calls `LlmPort.chat_json` with a JSON schema and persists through the repository, not legacy `jobs.fit_score`.
- The structured schema asks for:
  - overall `score` from 1 to 10,
  - `technical_fit`, `experience_fit`, and `role_fit`,
  - matched `keywords`,
  - short `reasoning`.
- `ScoreParser` validates the overall score, requires the raw keyword field to be present, rejects missing, empty, and blank-only keyword arrays, clamps component dimensions into 0..10, and returns typed value objects.
- `job_scores` stores versioned scores with `breakdown_json`, `keywords_json`, `scored_at`, and optional correction metadata.
- `CorrectScoreUseCase` exists and emits `ScoreCorrected`.
- Operations projections, shared read-model types, and the web jobs drawer expose the typed score evidence already persisted: `scoreBreakdown`, `scoreKeywords`, `scoreVersion`, and `scoredAt`.

Key code:

- `workers/automation/src/jobhunter/domain/scoring/use_cases.py`
- `workers/automation/src/jobhunter/domain/scoring/services.py`
- `workers/automation/src/jobhunter/domain/scoring/value_objects.py`
- `workers/automation/src/jobhunter/infrastructure/scoring/sqlite_repository.py`
- `workers/automation/tests/test_score_use_cases.py`
- `workers/automation/tests/test_scorer.py`
- `apps/api/src/read-model.ts`
- `packages/domain-types/src/operations/index.ts`
- `apps/web/src/contexts/scoring/components/ScoreBreakdown.tsx`

### Gaps

- `scoreCriteria` is saved in profile settings but is not passed into `ScoreJobUseCase`, the prompt, or the persisted score criteria.
- The LLM sees mostly resume baseline text plus title, company, location, and description. It does not explicitly receive the structured profile fields that matter for fit, such as work authorization, compensation, target roles, target locations, target work models, and negative preferences.
- The typed score surface is still limited to the existing three dimensions, keywords, version, and timestamp; it does not yet expose eligibility, evidence, missing qualifications, transferable signals, confidence, criteria version, or fit band.
- `useCorrectScoreMutation` throws `NotImplementedError`; no API route or UI writes score corrections.
- There is no offline scoring evaluation set, no ranking metrics, no calibration report, and no regression matrix for prompt or model changes.
- There is no feedback loop using corrections, apply/save/dismiss behavior, or downstream outcomes to improve ranking.
- There is no explicit separation between hard eligibility constraints and soft fit. A high score can hide a non-negotiable mismatch, and a low score can hide a job worth manually reviewing.

## Research Findings

### Industry Job Matching Uses Structured Signals Plus Personalization

LinkedIn's user-facing job match compares required and preferred qualifications from the job against skills and experience in the user's profile and resume, then gives a rating and insight summary. LinkedIn also says hirers use skill and experience signals as searchable filters, so the job-seeker-facing score needs to explain which qualifications matched or were missing. Source: [LinkedIn Help: how job match levels are calculated](https://www.linkedin.com/help/linkedin/answer/a8074185).

LinkedIn engineering describes recommendation personalization as a mix of content features and recent job-seeking activity. Apply, save, and dismiss actions are converted into job activity embeddings, with recency-weighted and learned aggregation outperforming simple skill averaging. Source: [LinkedIn Engineering: job matching with activity features](https://www.linkedin.com/blog/engineering/machine-learning/improving-job-matching-with-machine-learned-activity-features-).

Implication for JobHunter: profile-only scoring is not enough. Corrections, saves, skips, generated-material approvals, dry runs, and applications should become explicit feedback signals once the correction path is wired.

### Modern Job-Recommendation Research Is Skill-Aware And Ranking-Oriented

Recent research frames job recommendation as a skill-aware ranking problem rather than one prompt returning one absolute score. JobFormer models job description tuples, skill distributions, and user profiles in a two-stage recall/ranking setup. Source: [JobFormer, arXiv 2404.04313](https://arxiv.org/abs/2404.04313).

ConFit targets sparse resume-job interaction data with data augmentation and contrastive learning, then evaluates with ranking metrics such as nDCG@10 against real datasets. Source: [ConFit, arXiv 2401.16349](https://arxiv.org/abs/2401.16349).

Implication for JobHunter: the first practical step is not training a model. It is designing the score data model and evaluation harness so future embeddings or learned rankers have a reliable target and regression suite.

### Taxonomies Help Normalize Skills And Occupations

O*NET is a U.S. Department of Labor occupational database updated on an annual schedule, with occupation profiles, skills, education, tools, and developer resources. Source: [U.S. Department of Labor O*NET](https://www.dol.gov/agencies/eta/onet?lang=en).

ESCO is the European Commission's multilingual classification of skills, competences, qualifications, and occupations, available through downloads and an API. Source: [ESCO portal](https://esco.ec.europa.eu/en).

Implication for JobHunter: do not make taxonomy normalization a prerequisite for the next PR. But the score model should have a place for canonical skill identifiers later, not just raw keyword strings.

### Scoring Must Be Explainable, Validated, And Human-Correctable

Even though JobHunter is applicant-side automation, employment scoring sits near regulated hiring workflows. The EEOC's guidance for employer selection procedures emphasizes job-related validation, understanding limitations, keeping procedures current with job requirements, and alternatives with less adverse impact. Source: [EEOC employment tests and selection procedures](https://www.eeoc.gov/laws/guidance/employment-tests-and-selection-procedures).

NYC Local Law 144 requires bias audits and notices before employers or employment agencies use automated employment decision tools. This does not directly apply to a local job-seeker triage tool, but it is the right warning sign if JobHunter ever becomes employer-side, shared, or used to rank candidates. Source: [NYC DCWP Automated Employment Decision Tools](https://www.nyc.gov/site/dca/about/automated-employment-decision-tools.page).

NIST AI RMF emphasizes governance, documentation, feedback processes, measurement, and ongoing monitoring for AI systems. Source: [NIST AI RMF](https://www.nist.gov/itl/ai-risk-management-framework) and [NIST AI RMF Core](https://airc.nist.gov/airmf-resources/airmf/5-sec-core/).

Implication for JobHunter: every score should be traceable to criteria, evidence, and model/prompt version; the user must be able to correct it; changes to scoring must be evaluated against regression examples.

## Target Scoring Model

### Domain Language

Keep `JobScore` as the aggregate root, but evolve its payload toward a `FitAssessment` shape:

- `overallFitScore`: the final resolved score users sort, filter, and gate on. The current domain enforces 1..10; if the product wants a true 0..10 scale, PR 2 must explicitly migrate `FitScore`, contracts, UI copy, fixtures, and downstream threshold semantics. Until then, 0 should mean "unscored/not applicable" only outside the persisted `FitScore` value object.
- `fitBand`: `excellent | strong | plausible | stretch | poor`.
- `eligibility`: hard constraints that can independently block or warn, such as work authorization, location/work model, compensation, application language, seniority floor, and explicit exclusions.
- `dimensions`: fixed scoring dimensions with normalized 0..10 values, weights, evidence, and gap notes.
- `matchedSignals`: structured matched skills, tools, domains, responsibilities, credentials, industries, and keywords.
- `missingSignals`: structured required or preferred qualifications not present in the profile.
- `transferableSignals`: adjacent experience that explains why a mismatch may still be plausible.
- `confidence`: `high | medium | low`, based on description quality, profile completeness, extraction agreement, and LLM parser quality.
- `criteriaVersion`: identifies the rubric text, weights, prompt version, model, and profile snapshot version used.
- `correction`: user override plus rationale, already modeled in the domain. Corrections should later calibrate future scores once the feedback capability exists.

### Recommended Dimensions

Initial weights should be simple and user-configurable later:

| Dimension | Weight | Notes |
| --- | ---: | --- |
| Must-have technical skills | 25 | Required languages, frameworks, platforms, and tools. |
| Adjacent or transferable skills | 10 | Evidence that gaps are bridgeable through related experience. |
| Seniority and scope | 15 | Years, level, leadership scope, ownership, and reporting expectations. |
| Role responsibility fit | 15 | Day-to-day work compared with recent candidate experience and target role. |
| Domain and industry fit | 10 | Regulated domains, B2B/B2C, infra/product/security/data, and sector context. |
| Preferences and constraints | 15 | Location, remote/hybrid, compensation, authorization, availability, and exclusions. Hard blockers stay separate from this soft score. |
| Application leverage | 10 | Whether tailoring can credibly produce strong materials without fabrication. |

The final score should be resolved and stored, not left as a UI-only decoration. It should be computed or validated from the structured assessment instead of accepted as an unsupported LLM opinion. Downstream gating should use both `overallFitScore >= minFitScore` and `eligibility.status != blocked`.

### LLM Role

Use the LLM as a structured extractor and reasoner, not as the sole source of truth:

- Deterministic code prepares candidate facts, job facts, criteria, and constraints.
- LLM fills a strict schema for evidence, gaps, transferable fit, confidence, and short rationale.
- Deterministic code computes or validates the final weighted score from the structured fields.
- Parser rejects missing required evidence, malformed dimensions, impossible scores, or unsupported claims.
- Observability records prompt version, model, response schema version, parse outcome, token/cost metadata, and score version.

## Pending PR Stack

### PR 2 - Make Scoring Criteria-Aware And Constraint-Aware

Branch: `scoring/criteria-aware`.

- Add a `ScoringCriteriaProvider` or equivalent application-layer adapter that loads `minFitScore`, `scoreCriteria`, `targetCriteria`, and profile preference fields.
- Pass `ScoringCriteria` into `ScoreJobUseCase`.
- Update `SCORE_SCHEMA` to include `eligibility`, `missing_signals`, `transferable_signals`, and `confidence`.
- Add deterministic prechecks for work authorization, target location/work model, compensation, and explicit exclusions before the LLM score is accepted.
- Decide whether the final persisted `FitScore` remains 1..10 or migrates to explicit 0..10 semantics. If it changes, update contracts, fixtures, threshold copy, and downstream selectors in the same PR.
- Persist `criteria_json` or an equivalent criteria snapshot on `job_scores`.
- Tests:
  - red/green parser tests for eligibility and confidence.
  - use-case tests proving `scoreCriteria` changes the prompt payload and criteria snapshot.
  - regression tests that hard blockers do not become high automatic apply candidates.
- QA:
  - `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_score_use_cases.py workers/automation/tests/test_scorer.py`
  - `pnpm api:test` if projection shapes change.

### PR 3 - Wire Score Corrections End To End

Branch: `scoring/corrections`.

- Add a TS API endpoint or JSON-RPC method for score correction.
- Implement `useCorrectScoreMutation` with optimistic update and rollback using the real patcher requirement from frontend conventions.
- Add a compact correction control in the job drawer.
- Persist correction rationale and publish `ScoreCorrected`.
- Invalidate job list, job detail, dashboard, and scoring keys via the existing SSE invalidation router.
- Tests:
  - Python `CorrectScoreUseCase` integration through SQLite.
  - API endpoint tests.
  - mutation success and rollback hook tests.
  - jobs drawer component test.
- QA:
  - API/web test commands above.
  - Playwright path: open job drawer, correct score, verify score update survives refresh.

### PR 4 - Add A Local Scoring Evaluation Harness

Branch: `scoring/eval-harness`.

- Add a small, redacted fixture set under a test-owned directory with synthetic jobs and candidate profiles.
- Define labels as:
  - expected `fitBand`,
  - must-have matches,
  - known blockers,
  - expected top-k ordering for a query/profile slice.
- Add an eval runner that can execute scorer versions against the fixture set without touching user data.
- Track:
  - exact parse validity,
  - band accuracy,
  - blocker precision/recall,
  - nDCG@k or MAP for ranking,
  - correction agreement once corrections exist.
- Document the eval gate in `docs/local-reliability-qa.md`.
- Tests:
  - unit tests for metrics.
  - snapshot-style fixture tests for stable expected outputs with fake LLM payloads.
- QA:
  - `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_scoring_eval*.py`

### PR 5 - Add Hybrid Similarity And Feedback Personalization

Branch: `scoring/hybrid-ranking`.

- Canonicalize extracted skills and keywords into a local scoring signal table.
- Add optional embeddings for resume sections, job sections, and skill phrases behind a driven port.
- Compute semantic similarity as one evidence input, not as the final score.
- Convert user behavior into feedback signals:
  - corrected score,
  - skipped job,
  - generated materials approved or discarded,
  - dry-run apply completed,
  - actual apply submitted.
- Start with transparent weight adjustments and few-shot correction examples before any trained ranker. Feedback should calibrate the final score, not replace the explainable assessment.
- Tests:
  - repository tests for signal persistence.
  - deterministic similarity adapter tests with fake vectors.
  - ranking tests proving feedback changes ordering without hiding evidence.

### PR 6 - Governance, Observability, And Safety Rails

Branch: `scoring/governance`.

- Record a score trace artifact or projection: model, prompt version, criteria version, profile version, extracted signals, accepted score, parser warnings, and correction history.
- Add Langfuse/OpenTelemetry attributes for scoring dimensions and parse validity without leaking resume/job private text.
- Add a dashboard or exportable local report for score quality and score corrections.
- Document the applicant-side boundary and employer-side warning in `README.md` and `docs/architecture.md`.
- Add a QA checklist entry requiring new scoring changes to update eval fixtures or explain why not.

## Product Rules

- A score is a decision aid, not an autonomous decision.
- Auto-apply must never be gated by score alone; it must require no hard blockers, approved materials policy, and the existing safety controls.
- Low confidence should surface as "review manually", not as a low score.
- A user correction is domain data. It should be stored, visible, reversible through a later correction, and usable for future calibration.
- Missing evidence should reduce confidence even when the LLM gives a high score.
- Scoring must never invent candidate experience to close a gap. If tailoring cannot support a claim, application leverage should fall.

## Done Criteria For The Stack

- The jobs drawer shows score dimensions, evidence, gaps, confidence, criteria, and corrections.
- The scorer consumes saved score criteria and structured profile preferences.
- Hard blockers are represented separately from the display score.
- Corrections work from UI to repository to SSE invalidation.
- A local eval harness exists and is required for scoring prompt/model/schema changes.
- Existing downstream commands still respect `--min-score`, but the implementation can also inspect eligibility blockers before tailoring or apply.
- Documentation names the applicant-side scope and the risks if JobHunter ever becomes employer-side scoring.

## Open Questions

- Should compensation and authorization be hard blockers by default, or warnings unless the user marks them as non-negotiable?
- Should score corrections feed the next score immediately as few-shot examples, or only after a minimum number of corrections prevents overfitting?
- Should O*NET or ESCO be the first canonical skill taxonomy, or should JobHunter start with a lightweight local alias table and defer taxonomy adoption?
- Should `scoreCriteria` stay free text, or become a weighted rubric editor after PR 2 proves the target dimensions?

## Completed Work

### PR 1 - Expose The Score Evidence Already Persisted

Status: done. Landed via PR #48 (`scoring/evidence-contract`).

- Extended Operations projections to carry `scoreBreakdown`, `scoreKeywords`, `scoreVersion`, and `scoredAt` from latest `job_scores`.
- Extended shared read-model types to expose these fields.
- Replaced web free-text-only score rendering with typed rendering in `apps/web/src/contexts/scoring/components/ScoreBreakdown.tsx`.
- Kept `scoreReasoning` as compatibility output while projections and fixtures migrated.
- Hardened `ScoreParser` so missing, empty, and blank-only keyword arrays fail parsing instead of normalizing to the `legacy` sentinel used for backfilled rows.
- Tests added or updated for API projections, parser keyword validation, read-model typing, React score rendering, and Storybook score states.
- Validation at the time of the PR covered API tests, web tests, web typecheck, and a seeded jobs-drawer smoke showing dimensions and keywords.
