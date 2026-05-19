# Calibrated Scoring Policy RFC

> **Status:** proposed.
> **Date:** 2026-05-19.
> **Scope:** Scoring consistency, user score-correction feedback, explicit rescoring, and the implementation stack needed to make corrections change future scoring behavior.

## Problem

JobHunter scoring is explainable enough to inspect a single score, but not
consistent enough to compare jobs confidently.

The current scorer asks the LLM to produce an absolute 1..10 score for one job
at a time. That creates two product problems:

- **Cross-job double standards.** Job A can get a 7 and job B can get an 8 even
  when B is weaker than A on the dimensions the user actually cares about. The
  model is not forced to compare the new score against prior calibrated
  examples.
- **Corrections do not change scoring policy.** `ScoreCorrected` is stored and
  can feed bounded downstream ranking adjustments, but the next scoring prompt
  does not learn from the correction as a first-class policy update.

The expected product behavior is stricter:

- A score must be consistent with a versioned rubric and nearby calibration
  anchors.
- A score correction is high-priority user feedback.
- Corrections must update how future jobs are scored.
- Corrections may mark comparable existing scores stale.
- Bulk recalculation must be explicit, not a silent rewrite of the job list.

## Current Implementation

The current system already has useful foundations:

- `JobScore` is a Scoring aggregate with versioned `job_scores` persistence.
- `ScoreBreakdown` records dimensions, fit band, confidence, eligibility,
  matched signals, missing signals, transferable signals, and reasoning.
- `ScoringCriteria` snapshots are persisted with each score.
- `CorrectScoreUseCase` creates a new score version with `ScoreCorrection`.
- `ScoreCorrected` is emitted and projected to the local UI.
- `workers/automation/src/jobhunter/infrastructure/scoring/feedback.py`
  collects corrections and selected user/job actions as transparent feedback
  signals.
- `rank_jobs_with_feedback(...)` applies bounded post-score adjustments for
  downstream ordering.
- `workers/automation/src/jobhunter/scoring/eval.py` measures parse validity,
  band accuracy, blockers, ranking, and correction agreement.

The gap is not storage or UI plumbing. The gap is that the scorer still treats
the LLM's per-job absolute score as authoritative. Feedback affects ranking
after a score exists; it does not yet produce a new scoring policy that future
scores must obey.

## Goals

1. Make `FitScore` consistent across jobs by introducing a versioned
   `ScoringPolicy`.
2. Move final score computation from "LLM says 1..10" to deterministic policy
   resolution over structured evidence.
3. Turn score corrections into durable calibration anchors.
4. Update future scoring immediately when a correction is saved.
5. Mark comparable uncorrected scores stale when policy changes.
6. Keep bulk rescoring explicit and user-triggered.
7. Preserve explainability: every score must show policy version, dimensions,
   evidence, anchor influence, and correction history.
8. Strengthen local evaluation so scoring changes cannot regress consistency or
   correction agreement silently.

## Non-Goals

- Do not train a model in this stack.
- Do not add employer-side candidate screening behavior.
- Do not replace the 1..10 `FitScore` contract.
- Do not make score corrections silently rewrite all existing jobs.
- Do not make embeddings or external taxonomies required for local scoring.
- Do not block the existing local workflow on large evaluation datasets.

## Domain Language

**ScoringPolicy** (Aggregate)
- Versioned scoring rule set used to resolve final `FitScore`.
- Owns rubric dimensions, weights, anchors, stale-score rules, and metadata.
- Identity: `(TenantId, policyVersion)`.

**ScoreDimension** (Value Object)
- A weighted scoring dimension. Initial dimensions should be stable and explicit:
  technical fit, seniority/scope, role responsibility, domain fit,
  preferences/constraints, application leverage, and transferable fit.

**CalibrationAnchor** (Value Object)
- A corrected or curated reference example used to constrain future scores.
- Contains job id, corrected score, prior score, correction rationale, extracted
  comparable signals, dimensions affected, and timestamp.

**CorrectionSignal** (Domain Fact)
- Structured interpretation of a user correction. It records what changed and
  why: score delta, rationale, affected dimensions, signal phrases, and whether
  the correction should create or update an anchor.

**ScoreStaleness** (Value Object)
- Explains why an existing score should be reviewed or recomputed.
- Reasons include `policy_changed`, `matching_anchor_changed`,
  `criteria_changed`, and `profile_changed`.

**PolicyScoreTrace** (Value Object)
- Metadata attached to each score: policy version, rubric version, prompt
  version, schema version, model, profile snapshot version, anchor ids, parser
  warnings, and deterministic scoring inputs. It must not store raw resume,
  raw job text, secrets, or private generated artifacts.

## Target Flow

```text
profile snapshot + scoring criteria + job posting
-> deterministic fact preparation
-> LLM extracts structured scoring evidence
-> ScoreParser validates evidence, not final authority
-> ScoringPolicy computes dimension scores and raw weighted score
-> calibration layer compares against anchors
-> final FitScore + ScoreBreakdown + PolicyScoreTrace
-> JobScored
```

The LLM should remain useful, but narrower:

- It extracts evidence, gaps, blockers, transferable signals, confidence, and
  rationale.
- It may propose dimension scores, but deterministic code owns the final score.
- The parser rejects unsupported or malformed evidence.
- The final persisted score is the policy output, not an unsupported LLM
  opinion.

## Correction Flow

```text
User saves score correction
-> CorrectScoreUseCase creates corrected JobScore version
-> ScoreCorrected event is published
-> CorrectionSignal is derived from rationale + score delta + score evidence
-> ScoringPolicy creates or updates a CalibrationAnchor
-> ScoringPolicyUpdated is recorded
-> comparable uncorrected scores are marked stale
-> UI shows what changed and offers explicit rescore
```

The correction must affect future scoring immediately. It must not silently
rewrite previous uncorrected scores. Existing comparable scores should instead
be discoverable as stale so the user can choose when to rescore.

## Consistency Rules

The policy layer should enforce these invariants:

- A job weaker than a calibration anchor on all important dimensions cannot
  receive a higher score unless the score trace names the differentiating
  evidence.
- A job stronger than a corrected-up anchor on the corrected dimension should
  not remain below that anchor without a blocker, missing signal, or low
  confidence explanation.
- Hard eligibility blockers remain outside the soft fit score and continue to
  block downstream automation.
- Low confidence should surface as review-needed evidence, not as a disguised
  low score.
- The same policy version plus same extracted facts should produce the same
  score.
- Any policy change that can alter scoring must create a new policy version.

## Comparable Score Detection

The first implementation should be transparent and local:

- Compare jobs by normalized dimensions already present in `ScoreBreakdown`.
- Use matched/missing/transferable signals and keywords to find nearby jobs.
- Include title, seniority phrases, role responsibility phrases, work model,
  location, and hard blockers.
- Avoid embeddings as a dependency in the first stack. Keep an adapter seam for
  semantic similarity later.

Comparable jobs should receive stale metadata only when a correction plausibly
applies. A correction on "too high because no engineering leadership" should
not mark unrelated individual-contributor backend jobs stale unless their
evidence overlaps the same dimension.

## Data Model

Add policy-owned persistence instead of overloading `job_scores`:

```sql
CREATE TABLE scoring_policies (
  tenant_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  rubric_json TEXT NOT NULL,
  anchors_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  created_from_event_id INTEGER,
  PRIMARY KEY (tenant_id, version)
);

CREATE TABLE scoring_correction_signals (
  tenant_id TEXT NOT NULL,
  signal_id TEXT NOT NULL,
  job_url TEXT NOT NULL,
  previous_score INTEGER NOT NULL,
  corrected_score INTEGER NOT NULL,
  rationale TEXT NOT NULL,
  affected_dimensions_json TEXT NOT NULL,
  extracted_terms_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  policy_version INTEGER,
  PRIMARY KEY (tenant_id, signal_id)
);

CREATE TABLE scoring_stale_scores (
  tenant_id TEXT NOT NULL,
  job_url TEXT NOT NULL,
  score_version INTEGER NOT NULL,
  stale_reason TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY (tenant_id, job_url, score_version, stale_reason)
);
```

Extend `job_scores.trace_json` or add a policy column to record:

- `scoring_policy_version`
- `rubric_version`
- `anchor_ids`
- deterministic weighted score inputs
- calibration adjustment
- stale status at score time

If schema churn becomes noisy, add the policy fields to `trace_json` first and
promote to columns only when the API needs filtering or indexing.

## API And UI

The local API should expose:

- Current scoring policy summary.
- Correction signal history.
- Stale scores for a job and global stale-score counts.
- Explicit rescore endpoint for stale scores.
- Score detail fields showing policy version and calibration anchors.

The jobs drawer should show:

- "Scored with policy vN."
- "Corrected score updated policy vN+1."
- Affected dimensions from the correction.
- Stale warning when the displayed score predates relevant policy changes.
- Explicit "Rescore stale jobs" control, scoped to the current job, selected
  jobs, or all stale comparable jobs.

The UI should not claim the system learned more than it can prove. If the
correction could not be parsed into affected dimensions, show it as a general
anchor with lower confidence.

## Evaluation

Scoring changes must expand the existing local harness. Required metrics:

- Parse validity for structured evidence.
- Deterministic policy-resolution accuracy independent from the raw LLM
  overall score.
- Dimension consistency against synthetic fixtures.
- Band accuracy.
- Hard-blocker precision and recall.
- Ranking nDCG or MAP.
- Correction agreement.
- Pairwise anchor consistency.
- Stale-score detection precision on correction fixtures.
- Reproducibility for same policy version and same extracted facts.
- Governance counters: current policy version, rubric version, anchor count,
  unresolved/resolved stale-marker counts, correction count, and correction
  agreement signal.

Evaluation sets should include:

- Synthetic fixtures for stable regression tests.
- Known-failure fixtures from real corrected scenarios, redacted before commit.
- Correction-pair fixtures where one job should be higher, lower, or tied
  relative to an anchor.
- Policy migration fixtures proving older scores remain readable.

Scoring prompt/schema/model changes must update eval fixtures or explain why
the change cannot affect scoring behavior.

Eval and governance outputs must stay non-sensitive. They may include
synthetic dimensions, aggregate counts, policy/rubric versions, and correction
agreement values. They must not include raw job URLs, correction rationales,
anchor IDs, resumes, job descriptions, generated artifacts, API keys, browser
profile data, local database paths, or application logs.

## Observability

OpenTelemetry/Langfuse metadata should include non-sensitive scoring policy
attributes:

- policy version
- rubric version
- prompt and schema version
- parser success
- final score
- raw weighted score
- calibration adjustment
- anchor count
- stale score count
- correction signal count

Do not export raw resumes, full job descriptions, generated materials, API
keys, local database paths, browser profile data, or application logs.

## Stacked Implementation Plan

### PR 1 - RFC

This document plus a narrow backlog pointer.

### PR 2 - Policy Model And Deterministic Score Resolution

- Add `ScoringPolicy`, `ScoreDimension`, `CalibrationAnchor`,
  `PolicyScoreTrace`, and repository ports.
- Add SQLite persistence for current policy version.
- Keep the existing LLM schema initially, but route final `FitScore` through
  deterministic policy resolution.
- Persist policy version and weighted-score trace metadata.
- Add unit tests for deterministic scoring and versioning.

### PR 3 - Correction Signals And Policy Updates

- Convert `ScoreCorrected` into `CorrectionSignal`.
- Parse correction rationale into affected dimensions and terms.
- Create or update calibration anchors.
- Create a new scoring policy version after correction.
- Keep corrected score persistence exactly as today, but add policy update
  evidence.
- Add tests proving corrections affect future scoring.

### PR 4 - Stale Score Marking And Explicit Rescore

- Detect comparable uncorrected scores affected by policy changes.
- Persist stale-score records.
- Add explicit rescore command/API path for stale scores.
- Ensure bulk rescoring is user-triggered.
- Add tests for stale-score selection, rescore clearing, and non-comparable
  jobs not being marked stale.

### PR 5 - API, Web UI, And Product Reflection

- Expose policy version, correction signal, anchor, and stale-score metadata in
  contracts and read models.
- Update the jobs drawer to show policy/staleness explanation.
- Add explicit rescore controls.
- Add optimistic updates and SSE invalidation for policy/stale-score changes.
- Add web unit/component tests and a Playwright path for correcting a score and
  seeing stale-score reflection.

### PR 6 - Evaluation And Governance Hardening

- Extend `workers/automation/src/jobhunter/scoring/eval.py`.
- Add deterministic policy-resolution checks independent from raw LLM overall
  score, cross-job consistency checks, and stale-score detection checks.
- Add correction-learning checks proving anchors/stale markers are created,
  subsequent traces cite updated policy metadata, and stale scores stay out of
  downstream queues until explicit reset/rescore.
- Update `docs/local-reliability-qa.md` and architecture docs.
- Add a local scoring policy governance report for operator review without
  exposing raw URLs, rationales, anchors, artifacts, or local paths.

## Done Criteria

The full stack is complete only when:

- A user correction changes future scoring behavior.
- Corrected jobs become calibration anchors.
- Every new score records scoring policy version.
- Comparable stale scores are discoverable.
- Bulk rescoring is explicit and clears stale markers when successful.
- The jobs drawer reflects policy and stale-score state.
- The local eval harness catches ranking and correction-agreement regressions.
- Existing downstream score gates still require no hard blockers.
- Documentation states the applicant-side boundary and local-only data handling.
