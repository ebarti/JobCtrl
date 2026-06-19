---
phase: 19-europe-public-market-estimates
plan: 19-01
status: completed
completed: 2026-06-19
requirements-completed:
  - SRC-02
  - SRC-03
  - EST-01
  - EST-02
  - EST-03
  - EST-04
  - EST-06
  - EST-07
key-files:
  created:
    - workers/automation/src/jobhunter/domain/compensation/market.py
    - workers/automation/src/jobhunter/infrastructure/compensation/sqlite_market_repository.py
    - workers/automation/tests/test_market_compensation_estimator.py
    - workers/automation/tests/test_market_compensation_repository.py
  modified:
    - workers/automation/src/jobhunter/database.py
    - workers/automation/src/jobhunter/domain/compensation/__init__.py
    - workers/automation/src/jobhunter/infrastructure/compensation/__init__.py
---

# Phase 19 Plan 19-01: Market Estimate Domain And Persistence Summary

## Completed

- Added deterministic Python domain types and estimator for Europe public market estimates.
- Added explicit estimate states: `not_requested`, `unsupported`, `source_unavailable`, `insufficient_evidence`, and `estimated_range`.
- Added confidence factors, source snapshots, warning codes, unsupported/insufficient/source-unavailable reasons, and conservative range gating.
- Added canonical SQLite table `job_market_compensation_estimates` and repository helpers for save/read/backfill.
- Added tests for Spain INE preference, Eurostat aggregate fallback, ESCO-only insufficiency, geography assumptions, unsupported non-Europe/component cases, stale source snapshots, low sample counts, dispersion, broad bands, posted-vs-market warnings, source allowlist, and persistence safety.
- Hardened review findings for tokenized geography detection, component/period compatibility, sanitized public-source snapshots, and non-persistence of the read-side `not_requested` marker.

## Commits

| Commit | Description |
| --- | --- |
| `ca3984a` | `feat(worker): persist europe market estimates` |
| `0a206cc` | `fix(compensation): harden europe market estimate boundaries` |

## Verification

- `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_market_compensation_estimator.py workers/automation/tests/test_market_compensation_repository.py -q` — passed, 29 tests.
- `uv --project workers/automation run --extra dev ruff check workers/automation/src/jobhunter/domain/compensation workers/automation/src/jobhunter/infrastructure/compensation workers/automation/src/jobhunter/database.py workers/automation/tests/test_market_compensation_estimator.py workers/automation/tests/test_market_compensation_repository.py` — passed.

## Deviations from Plan

None - plan executed exactly as written.

## Self-Check: PASSED

Plan 19-01 satisfies the Python domain and persistence scope and is ready for Plan 19-02 API exposure.
