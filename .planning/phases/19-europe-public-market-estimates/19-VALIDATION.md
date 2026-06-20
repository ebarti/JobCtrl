---
phase: 19-europe-public-market-estimates
status: passed
validated: 2026-06-19
plans:
  - 19-01
  - 19-02
requirements:
  - SRC-02
  - SRC-03
  - EST-01
  - EST-02
  - EST-03
  - EST-04
  - EST-06
  - EST-07
---

# 19 Validation: Europe Public Market Estimates Plans

## Gate Result

Plan quality gate passes for execution.

## Coverage

| Requirement | Plan Coverage |
| --- | --- |
| SRC-02 | 19-01 allowlists Eurostat SES, ESCO, and Spain INE only; tests reject licensed and non-European source IDs. |
| SRC-03 | 19-01/19-02 store and serialize aggregate bucket, geography scope, attribution, and aggregate-baseline warnings. |
| EST-01 | 19-01 models all five estimate states; 19-02 round-trips them through the API. |
| EST-02 | 19-01 gates range output by occupation, geography, seniority, component, freshness, sample support, and dispersion. |
| EST-03 | 19-01 persists confidence factors; 19-02 exposes confidence band/score, source count, sample count, freshness, dispersion, and factor reasons. |
| EST-04 | 19-01/19-02 require insufficient-evidence reasons and no range fields for weak support. |
| EST-06 | 19-01 covers remote-Europe, Spain-local, EU-wide, non-EU-Europe, and unknown-location assumption warnings. |
| EST-07 | 19-01 emits source-conflict and broad-aggregate warnings; 19-02 adds a boundary regression proving no scoring/apply behavior changes. |

## Key Constraints Verified

- No live external network fetchers, browser scraping, mailbox access, auto-apply, or destructive local actions are planned.
- Phase 19 does not add job list/detail compensation summary fields, SSE invalidation, Jobs UI, profile-floor comparison, ranking, filtering, scoring, apply-readiness, or apply-dispatch behavior.
- Read-only API inspection uses canonical persisted rows and returns `not_requested` without write-on-read.
- README update is not required unless implementation adds user-facing CLI or Jobs UI behavior.

## Reviewer Notes

The exact confidence thresholds are implementation policy, but the plans require conservative tests proving weak evidence degrades to `insufficient_evidence` or another non-range state. This is the critical anti-false-precision invariant for Phase 19.
