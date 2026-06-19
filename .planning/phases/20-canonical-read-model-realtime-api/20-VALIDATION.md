---
phase: 20-canonical-read-model-realtime-api
type: validation
status: pending
---

# Phase 20 Validation

| Gate | Command | Status |
| --- | --- | --- |
| Projection parity | `corepack pnpm --filter @jobhunter/api exec vitest run test/projections.test.ts -t "compensation"` | pending |
| Python projections | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_projection_builder.py -q` | pending |
| Contracts | `corepack pnpm --filter @jobhunter/contracts check` | pending |
| Domain events | `corepack pnpm --filter @jobhunter/domain-types test -- --runInBand` | pending |
| Web invalidation | `corepack pnpm --filter @jobhunter/web test -- contexts/operations/every-event-has-handler.test.ts contexts/operations/invalidation-router.test.ts` | pending |
| API focused | `corepack pnpm --filter @jobhunter/api exec vitest run test/server.test.ts -t "compensation boundary"` | pending |
| API typecheck | `corepack pnpm api:check` | pending |
| API suite | `corepack pnpm api:test` | pending |
| Python compensation repos | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_posted_compensation_repository.py workers/automation/tests/test_market_compensation_repository.py -q` | pending |
| Diff whitespace | `git diff --check origin/phase/19-europe-public-market-estimates...HEAD` | pending |

## Manual QA

Phase 20 does not add visible Jobs UI. Product-path browser QA is deferred to Phase 21/22, where the structured fields are rendered in the Jobs list and drawer. Phase 20 QA focuses on API/read-model responses and SSE invalidation tests.
