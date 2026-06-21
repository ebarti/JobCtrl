---
phase: 18-posted-compensation-facts
plan: 18-01
status: completed
completed: 2026-06-19
requirements-completed:
  - COMP-01
  - COMP-02
  - COMP-03
  - COMP-04
  - COMP-05
---

# 18-01 Summary: Posted Compensation Parser And Persistence

## Completed

- Added a Python posted-compensation domain model and deterministic parser with explicit parse states: `missing`, `unparseable`, `ambiguous`, and `parsed_range`.
- Added canonical SQLite storage in `job_posted_compensation_facts`, separate from the legacy raw `jobs.salary` fallback.
- Added a repository for fact upsert/read/backfill from legacy salary text.
- Wired JobSpy discovery refreshes to parse and persist bounded salary text after job writes.
- Added parser and repository regression coverage for missing/unparseable/ambiguous/range states, hourly/monthly/annual assumptions, broad/one-sided ranges, missing currency/period, OTE/bonus/commission/equity warnings, bounded source text, raw fallback preservation, idempotent backfill, and JobSpy persistence.

## Boundary

- No market estimate, profile-floor comparison, ranking, filtering, scoring, apply readiness, SSE invalidation, or Jobs triage UI behavior was added.
- Full descriptions and provider raw payloads are not parsed or stored as posted-compensation source text.
- Mixed-component multi-amount text fails closed as `ambiguous`; explicit single base salary with bonus/commission/equity text remains `base_salary` with warnings.

## Verification

- `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_posted_compensation_parser.py workers/automation/tests/test_posted_compensation_repository.py workers/automation/tests/test_discovery_identity.py workers/automation/tests/test_discovery_limits.py -q` — passed, 62 tests.
- `uv --project workers/automation run --extra dev ruff check workers/automation/src/jobhunter/domain/compensation workers/automation/src/jobhunter/infrastructure/compensation workers/automation/src/jobhunter/database.py workers/automation/src/jobhunter/discovery/jobspy.py workers/automation/tests/test_posted_compensation_parser.py workers/automation/tests/test_posted_compensation_repository.py workers/automation/tests/test_discovery_identity.py workers/automation/tests/test_discovery_limits.py` — passed.
