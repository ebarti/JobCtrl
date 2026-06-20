---
phase: 20-canonical-read-model-realtime-api
status: passed
verified: 2026-06-19
requirements:
  - EST-05
  - API-01
  - API-02
  - API-03
  - API-04
  - API-05
---

# 20 Verification: Canonical Read Model & Realtime API

## Result

Phase 20 passes. Job list/detail compensation fields are projection-backed, posted facts and market estimates remain separate, Python and TypeScript projection paths are covered by parity-style regressions, and compensation updates invalidate the existing Operations job reads through safe event payloads.

## Requirement Evidence

| Requirement | Evidence |
| --- | --- |
| EST-05 | Compensation summaries and audits expose confidence, source, warning, and unavailable/insufficient state markers from canonical posted-fact and market-estimate rows. |
| API-01 | `JobSummary` carries `compensationSummary`; `JobDetail` carries top-level `compensationAudit`; both deserialize projection JSON without client-side parsing. |
| API-02 | TypeScript and Python projection tests cover the same posted parsed range plus reported company-role market estimate structure, including raw salary compatibility and no unsafe source labels. |
| API-03 | `CompensationFactsUpdated` emits safe state markers and Operations invalidates job list/detail queries for compensation changes. |
| API-04 | Server boundary tests prove compensation fields are additive while filtering, ranking, apply readiness, and apply dispatch remain unchanged. |
| API-05 | Event/repository/projection tests assert no source text, benchmark pages, profile preferences, local paths, credentials, or raw Glassdoor/Levels.fyi payloads leak through event or projection surfaces. |

## Verification Commands

- `corepack pnpm --filter @jobhunter/contracts check` - passed.
- `corepack pnpm --filter @jobhunter/api-client check` - passed.
- `corepack pnpm api:check` - passed.
- `corepack pnpm web:check` - passed.
- `corepack pnpm web:build` - passed, with the existing large-chunk warning.
- `corepack pnpm --filter @jobhunter/domain-types test` - passed, 12 files and 170 tests.
- `corepack pnpm --filter @jobhunter/web exec vitest run src/contexts/operations/every-event-has-handler.test.ts src/contexts/operations/invalidation-router.test.ts` - passed, 2 files and 171 tests.
- `corepack pnpm --filter @jobhunter/api exec vitest run test/projections.test.ts -t "compensation"` - passed, 1 test.
- `corepack pnpm --filter @jobhunter/api exec vitest run test/server.test.ts -t "compensation boundary"` - passed, 2 tests.
- `corepack pnpm api:test` - passed, 14 files and 243 tests.
- `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_projection_builder.py workers/automation/tests/test_posted_compensation_repository.py workers/automation/tests/test_market_compensation_repository.py -q` - passed, 24 tests.
- `uv --project workers/automation run --extra dev ruff check workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py workers/automation/src/jobhunter/infrastructure/projections/sqlite_projection_store.py workers/automation/src/jobhunter/domain/operations/projections.py workers/automation/src/jobhunter/infrastructure/compensation/sqlite_repository.py workers/automation/src/jobhunter/infrastructure/compensation/sqlite_market_repository.py workers/automation/tests/test_projection_builder.py workers/automation/tests/test_posted_compensation_repository.py workers/automation/tests/test_market_compensation_repository.py` - passed.
- `git diff --check origin/phase/19-europe-public-market-estimates...HEAD` - passed.

## Review And QA

- QA: Gate PASS for API/read-model behavior, SSE invalidation routing, event safety, projection parity, and no visible Jobs UI change.
- Product-path browser QA: deferred to Phase 21/22 because Phase 20 only exposes structured fields and realtime invalidation, without rendering compensation UI.

## Boundaries Verified

- No U.S. salary baseline support.
- No automated Glassdoor or Levels.fyi salary fetch/cache path; only safe attribution for permitted/manual reported rows is surfaced.
- No browser submission, auto-apply, mailbox scan, profile mutation, destructive database/profile action, or live external scraping.
- No salary-based ranking, filtering, scoring, apply readiness, apply blockers, or apply dispatch behavior.
- No profile compensation preferences, credentials, local paths, raw benchmark pages, unsafe source labels, or unauthorized source payloads in event or projection outputs.
