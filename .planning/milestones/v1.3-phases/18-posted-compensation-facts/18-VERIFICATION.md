---
phase: 18-posted-compensation-facts
status: passed
verified: 2026-06-19
requirements:
  - COMP-01
  - COMP-02
  - COMP-03
  - COMP-04
  - COMP-05
---

# 18 Verification: Posted Compensation Facts

## Result

Phase 18 passes. Posted compensation facts are parsed and persisted as canonical local rows, exposed through a narrow read-only inspection API, and kept separate from both legacy raw `jobs.salary` and future market estimates.

## Requirement Evidence

| Requirement | Evidence |
| --- | --- |
| COMP-01 | Parser, repository, and API tests cover `missing`, `unparseable`, `ambiguous`, `parsed_range`, and `not_recorded` inspection states. |
| COMP-02 | Facts persist and return bounded `sourceText`; long source strings are truncated and warned. Full descriptions/provider payloads are not stored. |
| COMP-03 | Parsed facts expose currency, period, component, min/max, and annualized values only for parsed ranges; annualized values require explicit assumptions. |
| COMP-04 | Parser tests cover hourly, monthly, OTE, bonus, commission, equity, broad range, one-sided range, missing currency, and missing period warnings. Review/QA findings for mixed-component false precision were fixed and regression-covered. |
| COMP-05 | Repository and API tests prove `jobs.salary` remains unchanged and is exposed only as legacy raw fallback when canonical facts are absent or unstructured. |

## Verification Commands

- `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_posted_compensation_parser.py workers/automation/tests/test_posted_compensation_repository.py workers/automation/tests/test_discovery_identity.py workers/automation/tests/test_discovery_limits.py -q` — passed, 62 tests.
- `uv --project workers/automation run --extra dev ruff check workers/automation/src/jobhunter/domain/compensation workers/automation/src/jobhunter/infrastructure/compensation workers/automation/src/jobhunter/database.py workers/automation/src/jobhunter/discovery/jobspy.py workers/automation/tests/test_posted_compensation_parser.py workers/automation/tests/test_posted_compensation_repository.py workers/automation/tests/test_discovery_identity.py workers/automation/tests/test_discovery_limits.py` — passed.
- `corepack pnpm --filter @jobhunter/api exec vitest run test/posted-compensation-facts.test.ts` — passed, 5 tests.
- `corepack pnpm --filter @jobhunter/api exec vitest run test/server.test.ts -t "compensation boundary"` — passed, 1 test.
- `corepack pnpm api:check` — passed.
- `corepack pnpm --filter @jobhunter/contracts check` — passed.
- `corepack pnpm --filter @jobhunter/api-client check` — passed.
- `corepack pnpm api:test` — passed, 13 files and 233 tests.
- `git diff --check` — passed.

## Review And QA

- Plan checker: Gate PASS after removing API write-on-read and resolving research questions.
- QA: Gate PASS after fixing mixed-component multi-amount salary parsing.
- PR review: Gate PASS after fixing single-base-plus-variable component classification and updating the stale seeded artifact QA expectation.

## Boundaries Verified

- No API write-on-read.
- No React parsing.
- No market estimates, profile-floor comparison, ranking, filtering, scoring, apply-readiness, apply dispatch, SSE invalidation, or Jobs triage UI changes.
- No Glassdoor or Levels.fyi salary fetch/cache/display path.
- No full descriptions, provider raw payloads, credentials, local paths, or private account state in fact rows or API responses.
