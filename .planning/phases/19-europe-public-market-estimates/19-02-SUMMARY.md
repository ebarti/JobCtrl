---
phase: 19-europe-public-market-estimates
plan: 19-02
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
    - apps/api/src/market-compensation-estimates.ts
    - apps/api/test/market-compensation-estimates.test.ts
  modified:
    - apps/api/src/server.ts
    - apps/api/test/server.test.ts
    - packages/contracts/src/schemas.ts
    - packages/api-client/src/client.ts
    - docs/local-ts-api.md
    - docs/architecture.md
    - docs/local-reliability-qa.md
---

# Phase 19 Plan 19-02: Market Estimate Inspection API Summary

## Completed

- Added shared TypeScript contracts for Europe public market estimate states, source snapshots, confidence factors, warnings, reasons, and recorded/not-requested responses.
- Added `marketCompensationEstimate(jobKey)` to `@jobhunter/api-client`.
- Added `GET /v1/jobs/:jobKey/compensation/market` as a read-only inspection endpoint backed by persisted `job_market_compensation_estimates` rows.
- Added safe JSON parsing and source/reason/warning allowlists so unknown or unsafe persisted source entries are dropped from API responses.
- Added tests for recorded range responses, non-range states, not-requested no-write-on-read behavior, unknown jobs, unsafe source filtering, private-data leakage, and the warning-only product boundary.
- Updated local API, architecture, and reliability QA documentation for the Phase 19 endpoint, canonical table, Europe-only source scope, and Phase 20/21 deferred boundaries.

## Commits

| Commit | Description |
| --- | --- |
| `b4ea12f` | `feat(api): expose europe market estimates` |

## Verification

- `corepack pnpm --filter @jobhunter/api exec vitest run test/market-compensation-estimates.test.ts` - passed, 6 tests.
- `corepack pnpm --filter @jobhunter/api exec vitest run test/server.test.ts -t "market compensation boundary"` - passed, 1 test.
- `corepack pnpm api:check` - passed.
- `corepack pnpm --filter @jobhunter/contracts check` - passed.
- `corepack pnpm --filter @jobhunter/api-client check` - passed.
- `corepack pnpm api:test` - passed, 14 files and 240 tests.
- `git diff --check` - passed.

## Deviations from Plan

None - plan executed exactly as written.

## Self-Check: PASSED

Plan 19-02 satisfies the TypeScript contract and read-only API scope. Phase-level completion still depends on final review and QA gates.
