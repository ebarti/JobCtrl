---
phase: 19-europe-public-market-estimates
status: passed
verified: 2026-06-19
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

# 19 Verification: Europe Public Market Estimates

## Result

Phase 19 passes. Europe public market estimates are deterministic local facts derived from allowed public sources only, persisted as canonical local rows, exposed through a narrow read-only inspection API, and kept separate from posted salary facts and future read-model/UI surfaces.

## Requirement Evidence

| Requirement | Evidence |
| --- | --- |
| SRC-02 | Estimator and API allowlist Eurostat Structure of Earnings Survey, ESCO occupation taxonomy, and Spain INE Wage Structure Survey only. Tests reject disabled/licensed and non-European source evidence. |
| SRC-03 | Market rows and API responses carry aggregate bucket, geography scope, attribution, source snapshots, and `aggregate_baseline` warnings rather than presenting public aggregates as company-specific market ranges. |
| EST-01 | Domain, repository, and API tests cover `not_requested`, `unsupported`, `source_unavailable`, `insufficient_evidence`, and `estimated_range` states. |
| EST-02 | Estimator gates ranges on ESCO occupation support, Europe geography, seniority, component/period compatibility, freshness, sample support, and source agreement. |
| EST-03 | Persisted/API estimates expose confidence band/score, source count, sample count, source snapshots, factor names, factor scores, factor bands, and deterministic factor reasons. |
| EST-04 | Weak source support, ESCO-only mapping, stale snapshots, low sample count, component mismatch, unsupported geography, and high dispersion degrade to non-range states with explicit reasons. |
| EST-06 | Tests cover remote-Europe, Spain-local, EU-wide, European Union, non-EU Europe, unknown-location, and non-Europe mappings with explicit warnings or unsupported states. |
| EST-07 | Broad aggregate ranges and posted-vs-market divergence are warning-only; server boundary tests prove no fit-score, filtering, apply-readiness, or apply-dispatch behavior changes. |

## Verification Commands

- `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_market_compensation_estimator.py workers/automation/tests/test_market_compensation_repository.py -q` - passed, 33 tests.
- `uv --project workers/automation run --extra dev ruff check workers/automation/src/jobhunter/domain/compensation workers/automation/src/jobhunter/infrastructure/compensation workers/automation/src/jobhunter/database.py workers/automation/tests/test_market_compensation_estimator.py workers/automation/tests/test_market_compensation_repository.py` - passed.
- `corepack pnpm --filter @jobhunter/api exec vitest run test/market-compensation-estimates.test.ts` - passed, 8 tests.
- `corepack pnpm --filter @jobhunter/api exec vitest run test/server.test.ts -t "market compensation boundary"` - passed, 1 test.
- `corepack pnpm api:check` - passed.
- `corepack pnpm --filter @jobhunter/contracts check` - passed.
- `corepack pnpm --filter @jobhunter/api-client check` - passed.
- `corepack pnpm api:test` - passed, 14 files and 242 tests.
- `git diff --check origin/phase/18-posted-compensation-facts...HEAD` - passed.

## Review And QA

- QA: Gate PASS after verifying Python estimator/repository tests, API tests, type checks, branch diff hygiene, no UI/projection/SSE changes, and no real scraping/apply/profile/mailbox/destructive flows.
- PR review: Gate PASS after fixing source metadata leakage, component/period compatibility, substring geography matching, persisted `not_requested`, unknown persisted states, `European Union` geography, stale repository source metadata, stale geography scope, and stale factor reason text.

## Boundaries Verified

- No API write-on-read.
- No live external network fetchers, browser scraping, mailbox access, auto-apply, or destructive local actions.
- No U.S. salary baseline support.
- ESCO is occupation taxonomy/mapping only, never wage observation.
- No Glassdoor or Levels.fyi salary fetch/cache/display path.
- No job list/detail projection changes, SSE invalidation, Jobs UI changes, profile-floor comparison, ranking, filtering, scoring, apply readiness, or apply dispatch behavior changes.
- No full descriptions, provider raw payloads, credentials, local paths, private account state, stale free-text source payloads, or unsafe factor reason text in market rows returned by repository/API read paths.
