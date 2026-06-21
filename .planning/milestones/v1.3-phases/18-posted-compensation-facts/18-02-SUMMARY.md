---
phase: 18-posted-compensation-facts
plan: 18-02
status: completed
completed: 2026-06-19
requirements-completed:
  - COMP-01
  - COMP-02
  - COMP-03
  - COMP-04
  - COMP-05
---

# 18-02 Summary: Posted Compensation Inspection API

## Completed

- Added shared TypeScript DTOs for posted compensation facts, warnings, parse states, and the `recorded` / `not_recorded` inspection response.
- Added `GET /v1/jobs/:jobKey/compensation/posted`, a read-only API endpoint that maps canonical fact rows and returns `not_recorded` for existing jobs without a canonical row.
- Added `postedCompensationFact(jobKey)` to `@jobhunter/api-client`.
- Added API tests for recorded parsed facts, missing/unparseable/ambiguous facts, `not_recorded`, no write-on-read, unknown job `404`, warning messages, and sensitive data redaction.
- Added a server boundary regression proving compensation facts do not change fit score, existing fit-score sorting/filtering, job detail apply audit/readiness, or apply dispatch behavior.
- Documented the inspection endpoint, canonical table, and QA coverage in the owning docs.

## Boundary

- The API endpoint does not parse, backfill, update, persist, extend projection refreshes, call external providers, or compute in React.
- `/v1/jobs` and `/v1/jobs/:key` did not gain Phase 20 compensation summary or audit fields.
- Phase 20 still owns projection-backed job list/detail propagation and SSE invalidation.
- Phase 21 still owns the Jobs triage UI.

## Verification

- `corepack pnpm --filter @jobhunter/api exec vitest run test/posted-compensation-facts.test.ts` — passed, 5 tests.
- `corepack pnpm --filter @jobhunter/api exec vitest run test/server.test.ts -t "compensation boundary"` — passed, 1 test.
- `corepack pnpm api:check` — passed.
- `corepack pnpm --filter @jobhunter/contracts check` — passed.
- `corepack pnpm --filter @jobhunter/api-client check` — passed.
