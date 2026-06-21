---
phase: 18-posted-compensation-facts
status: planned
validation: nyquist
requirements:
  - COMP-01
  - COMP-02
  - COMP-03
  - COMP-04
  - COMP-05
---

# 18 Validation Plan

## Invariants

- Posted compensation facts are canonical persisted rows, not React-only or list-render-time parsing.
- `jobs.salary` remains a compatibility/raw fallback field and is never replaced by normalized values.
- Parse states are explicit: `missing`, `unparseable`, `ambiguous`, or `parsed_range`.
- Normalized range fields and annualized values are only present when their assumptions are explicit.
- Phase 18 does not add market estimates, profile-floor comparison, scoring changes, ranking, filtering, apply-readiness changes, SSE invalidation, or Jobs triage UI changes.
- All tests use synthetic salary strings and local temp databases only.

## Requirement Coverage

| Requirement | Automated Validation | Product Validation |
| --- | --- | --- |
| COMP-01 | Parser tests cover all four parse states; API tests return the state for existing jobs. | A known job can be inspected and the state is explicit even when no posted salary exists. |
| COMP-02 | Parser/repository/API tests assert bounded source text is persisted and returned. | The inspection endpoint shows the exact salary/source excerpt, not a silent derived value. |
| COMP-03 | Parser and API tests assert currency, period, component, min, max, and annualized fields only appear for valid parsed facts with assumptions. | Users see normalized fields only when the parser can explain them. |
| COMP-04 | Parser tests cover hourly, monthly, OTE, bonus, commission, equity, broad range, one-sided range, missing currency, and missing period warnings. | Risky salary text is labeled with confidence and warnings instead of presented as precise fact. |
| COMP-05 | Repository and API tests assert `legacyRawSalary` remains available and `jobs.salary` is unchanged by backfill/discovery integration. | Legacy salary strings remain visible as fallback and compatibility data. |

## Required Commands

- `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_posted_compensation_parser.py workers/automation/tests/test_posted_compensation_repository.py workers/automation/tests/test_discovery_identity.py`
- `uv --project workers/automation run --extra dev ruff check workers/automation/src/jobhunter/domain/compensation workers/automation/src/jobhunter/infrastructure/compensation workers/automation/src/jobhunter/database.py workers/automation/src/jobhunter/discovery/jobspy.py workers/automation/tests/test_posted_compensation_parser.py workers/automation/tests/test_posted_compensation_repository.py`
- `corepack pnpm --filter @jobhunter/api exec vitest run test/posted-compensation-facts.test.ts`
- `corepack pnpm --filter @jobhunter/api exec vitest run test/server.test.ts -t "compensation boundary"`
- `corepack pnpm api:check`
- `rg -n "apply readiness|applyReadiness|rank|ranking|sort.*salary|filter.*salary|profile floor|profileFloor|market estimate|marketEstimate" apps packages workers`
- `git diff --check`

## Manual QA

- Seed or use a temp API database with synthetic jobs whose salary strings exercise parsed, missing, unparseable, ambiguous, hourly, monthly, broad-range, one-sided, OTE, bonus, commission, equity, missing-currency, and missing-period cases.
- Call `GET /v1/jobs/:jobKey/compensation/posted` for representative jobs and confirm source text, raw fallback, confidence, warnings, and assumptions are visible.
- Confirm `/v1/jobs` and `/v1/jobs/:jobKey` still expose the legacy `salary` field without new Phase 20 compensation summaries.
- Confirm no product control triggers auto-apply, browser submission, material regeneration, destructive profile/database behavior, external scraping, or licensed-source fetches.
