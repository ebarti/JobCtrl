# Scoring Policy

How a discovered job becomes a defensible fit score: profile retrieval feeds a
deterministic, versioned scoring policy over structured evidence. Execution-level
detail lives in the [Stage Walkthrough](pipeline/stages.md); the domain model is in
[Tactical Design](domain-model/tactical.md).

**Read this if** you need to know how the fit score is produced, what it is based
on, and what it must not be used for.

```mermaid
flowchart TB
    JOBS@{ icon: "tabler:briefcase", form: "rounded", label: "Normalized jobs", h: 64 }
    RETRIEVE@{ icon: "tabler:filter", form: "rounded", label: "Retrieve<br/>top-N pool", h: 64 }
    SCORE@{ icon: "tabler:scale", form: "rounded", label: "Score<br/>profile + policy", h: 64 }
    RESULT@{ shape: "docs", label: "Fit score<br/>evidence + trace" }
    REVIEW@{ icon: "tabler:browser", form: "rounded", label: "API +<br/>Job Detail", h: 64 }
    POLICY@{ icon: "tabler:adjustments", form: "rounded", label: "Next policy version<br/>+ calibration anchor", h: 64 }

    subgraph DECISION["Candidate decision"]
      direction LR
      JOBS -->|candidate pool| RETRIEVE
      RETRIEVE -->|top N| SCORE
    end

    subgraph AUDIT["Evidence and calibration"]
      direction LR
      RESULT -->|shown in| REVIEW
      REVIEW -->|user correction| POLICY
    end

    SCORE -->|decision record| RESULT
    POLICY -.->|next scoring run| SCORE
```

Retrieval narrows the candidate pool before any LLM call; a user correction feeds
back as a new score version and a calibration anchor on the scoring policy.

## Retrieval Before Scoring

The Scoring context owns a local hybrid retrieval service under
`workers/automation/src/jobctrl/domain/scoring/retrieval.py`. It builds an
in-memory lexical index over normalized posting fields already produced by
Discovery, including Discovery's internal detail-enrichment queue drain, then
ranks candidate jobs before the scorer spends LLM calls. When
`jobctrl run score --limit N` or equivalent pipeline calls cap scoring, the
runner fetches a broader pending/enriched pool and lets hybrid retrieval choose
the top N.

Semantic search is optional. The `EmbeddingIndexPort` in
`workers/automation/src/jobctrl/domain/ports/retrieval.py` is the adapter seam
for a hosted or local embedding index; local mode defaults to
`DisabledEmbeddingIndex`, so lexical retrieval and scoring continue to work
without any external embedding service.

## Scoring Fit Assessment

The Scoring context keeps `FitScore` as a 1..10 applicant-side triage signal,
but each persisted `job_scores` row also stores the criteria snapshot and trace
used to produce it. `criteria_json` records the saved score criteria, target
criteria, minimum score, and structured profile preference fields used for the
prompt. `trace_json` records non-sensitive audit metadata: prompt/schema
versions, model name, criteria version, profile snapshot version, parser
warnings, and correction history.

### Deterministic Score Resolution

When the accepted employer analysis provides explicit requirement IDs and the
scorer returns requirement assessments, `requirement-fit-v1` owns the persisted
score. The scorer response supplies each assessment's requirement identity,
text, tier, weight, posting-evidence span, fit classification, and profile
evidence IDs. The parser validates field shape and ranges and requires at least
one non-empty evidence ID for matched and transferable rows. It does not
currently reconcile those returned IDs or requirement fields against the
canonical employer analysis and profile evidence before resolution. The
formula is therefore deterministic over the accepted parsed response, while
its grounding still depends on the scorer returning the supplied source fields
faithfully. Evidence resolution in the read model can later mark an unknown ID
unavailable, but that display-time result does not retroactively change the
score.

For each parsed requirement assessment:

- `max_points = requirement weight × tier multiplier`, where must-have is
  `1.25` and nice-to-have is `1.0`;
- direct match has fit value `1.0`, strong match `0.85`, transferable evidence
  `0.6`, and missing, blocked, or not-assessed `0.0`;
- `awarded_points = max_points × fit value`.

The resolver rounds each row's `max_points` and `awarded_points` to four
decimal places, then computes
`weighted_fit = sum(awarded_points) / sum(max_points)` and then
`score = 1 + floor(9 × weighted_fit + 0.5)`, clamped to 1–10. One or more
blocked requirement rows cap the result at 4. The report separately records
must-have coverage, blocker count, and the number of missing or blocked
requirements whose saved weight is at least `0.75`.

Requirement-led resolution runs only when at least one valid assessment row is
returned and the employer-analysis generation is greater than zero. Otherwise,
the compatibility policy resolves three 0–10 model-classified dimensions with
a deterministic weighted mean: technical fit `0.45`, experience fit `0.30`,
and role fit `0.25`. It uses nearest-integer half-up rounding, clamps the final
score to 1–10, and applies the same bands: excellent at 9, strong at 7,
plausible at 5, stretch at 3, and poor at 1. Confidence and eligibility are
trace-only policy inputs rather than numeric adjustments. The Discovery
minimum-fit threshold gates downstream materials but is not an input to either
score formula.

The score breakdown separates soft fit from hard eligibility. `fit_band`,
`confidence`, matched/missing/transferable signals, warnings, and hard blockers
are exposed through the TypeScript API and Job Detail route workspace. User corrections create a new
score version, preserve the correction rationale, publish `ScoreCorrected`, and
can be read back as transparent feedback signals alongside existing job actions.
They also create a non-sensitive correction signal that is persisted as a
calibration anchor on the next `scoring_policies` version. The current policy
keeps rubric weights and fit-band thresholds stable; subsequent scores load the
latest policy version and include the active anchor IDs in `trace_json`.

::: warning Applicant-side triage only — not an employer hiring system
This is not an employer-side candidate selection system. If JobCtrl is ever
used to rank people for hiring decisions, the architecture needs a separate
governance layer for validation, bias audits, notices, adverse-impact review,
and human-review procedures before production use.
:::
