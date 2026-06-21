---
phase: 22-product-path-qa-safety-release
plan: "02"
subsystem: qa
tags: [compensation, estimator, api, projections, synthetic-fixtures, safety]

requires:
  - phase: 22-product-path-qa-safety-release
    provides: 22-01 matrix-first release QA fixture registry and execution matrix
provides:
  - Python estimator tests for trimodal tier fallback, inferred trimodal tier, low sample, weak level, weak location, and high source dispersion
  - Estimator behavior that treats trimodal tier fallback as valid tier-backed support and prevents low-sample precise ranges
  - API and projection tests proving trimodal fallback and source-conflict evidence is served from canonical market rows
  - Unsafe source payload regression checks for API/projection serialized compensation JSON
affects: [phase-22, qa-release-gate, compensation-estimator, market-compensation-api, compensation-projections]

tech-stack:
  added: []
  patterns: [TDD regression fixtures, canonical-row projection evidence, synthetic-only compensation QA]

key-files:
  created:
    - .planning/phases/22-product-path-qa-safety-release/22-02-SUMMARY.md
  modified:
    - workers/automation/tests/test_market_compensation_estimator.py
    - workers/automation/src/jobhunter/domain/compensation/market.py
    - apps/api/test/market-compensation-estimates.test.ts
    - apps/api/test/projections.test.ts

key-decisions:
  - "Trimodal tier fallback may use same-tier company-role evidence when the target company supplies tier context, but it remains confidence-limited."
  - "Sub-threshold reported compensation samples degrade below precise-range confidence and return insufficient evidence."
  - "Task 2 required no production mapping change because the API/projection canonical-row path already preserved the requested trimodal fallback and source-conflict fields safely."

patterns-established:
  - "Weak market-estimate evidence tests assert explicit warning/reason codes and absence of precise ranges."
  - "API/projection release fixtures seed canonical SQLite rows and assert serialized JSON excludes local paths, credentials, raw provider payloads, and secrets."

requirements-completed: [QA-01, QA-03, QA-04]

duration: 5min
completed: 2026-06-21
---

# Phase 22 Plan 02: Backend API Projection Evidence Summary

**Synthetic estimator and canonical-row API tests now prove weak compensation evidence degrades confidence while trimodal fallback and source-conflict data stay source-backed and sanitized.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-06-21T02:25:30Z
- **Completed:** 2026-06-21T02:30:21Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- Added direct Python estimator coverage for trimodal tier role fallback, inferred trimodal tier, low sample count, weak level match, weak location match, and excessive source dispersion.
- Updated the estimator so tier-role fallback can use target-company tier context without requiring same-company evidence, while low-sample support no longer emits a precise range.
- Added API and projection tests that seed canonical `job_posted_compensation_facts` and `job_market_compensation_estimates` rows, then assert trimodal fallback, source conflict, warning codes, factor names, source snapshots, and unsafe-string exclusions.

## Task Commits

Each task was committed atomically:

1. **Task 1 RED: Add weak-market estimator evidence tests** - `9a060f8` (test)
2. **Task 1 GREEN: Implement weak market evidence degradation** - `5c14b0a` (feat)
3. **Task 2: Add canonical API/projection release evidence** - `b51c771` (test)

## Files Created/Modified

- `workers/automation/tests/test_market_compensation_estimator.py` - Added the three named Phase 22 weak-market estimator tests and helper overrides for synthetic location, tier, and level rows.
- `workers/automation/src/jobhunter/domain/compensation/market.py` - Adjusted tier fallback company scoring and low-sample scoring so weak evidence returns explicit insufficient evidence.
- `apps/api/test/market-compensation-estimates.test.ts` - Added canonical market-row API evidence for trimodal fallback and source-conflict warnings.
- `apps/api/test/projections.test.ts` - Added projection evidence from canonical posted and market rows with unsafe source payload assertions.
- `.planning/phases/22-product-path-qa-safety-release/22-02-SUMMARY.md` - This plan summary and self-check record.

## Decisions Made

- Trimodal tier fallback is valid only as bounded-confidence support: the target company must supply tier context, and same-tier role rows can then support a tier-role fallback estimate.
- Reported compensation samples below `LOW_SAMPLE_THRESHOLD` should not satisfy the precise-range confidence floor.
- Task 2 stayed test-only because the existing API/projection mapping already served the requested canonical fields and sanitization behavior.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Task 2 RED tests passed immediately. Investigation showed the requested canonical-row API/projection behavior already existed, so no production mapping change was made.

## Known Stubs

None. Stub-pattern scan only found ordinary code identifiers (`placeholders`) and an intentional empty-company test input.

## Threat Flags

None - no new endpoint, auth path, schema migration, provider access path, file access pattern, ranking/filtering/readiness behavior, or apply/dispatch behavior was introduced.

## Verification

- `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_market_compensation_estimator.py` - PASS, 11 tests.
- `corepack pnpm api:test -- market-compensation-estimates.test.ts projections.test.ts` - PASS, 14 files / 272 tests.
- `git diff --check` - PASS.
- Task 1 RED observation: initial pytest failed for trimodal fallback and weak market degradation before the production change.
- Task 2 RED observation: targeted API tests passed immediately, confirming existing canonical mapping support.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plan 22-03 can use these backend/API fixtures as canonical evidence while adding frontend-visible source-conflict and product-path safety assertions. Plan 22-04 can roll the passing commands into final release verification.

## Self-Check: PASSED

- Created summary file exists: `.planning/phases/22-product-path-qa-safety-release/22-02-SUMMARY.md`.
- Task commit `9a060f8` exists.
- Task commit `5c14b0a` exists.
- Task commit `b51c771` exists.
- No tracked file deletions were introduced by task commits.

---
*Phase: 22-product-path-qa-safety-release*
*Completed: 2026-06-21*
