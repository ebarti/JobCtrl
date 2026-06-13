---
phase: 13-shared-apply-audit-contract
plan: 13-01
status: completed
completed_at: 2026-06-11
---

# 13-01 Summary - Contract And API Derivation

## Completed

- Added `ApplyAudit`, `ApplyAuditFact`, and `ApplyAuditSource` contract types with `ready`, `preparing`, `blocked`, and `repair` states.
- Added `applyAudit` to both `ApplyReviewQueueItem` and `JobDetail`.
- Added `apps/api/src/apply-audit.ts` as the shared derivation helper.
- Wired `reviewQueueItemFromRow` to build `applyAudit` from application target, material flags, stage state/error, latest apply run, score eligibility, and review-evidence availability.
- Wired `getJobDetail` to query latest apply-run context and build the same `applyAudit` DTO from the same source facts.
- Kept legacy `materials` and `blockers` compatibility fields.
- Updated queue score parsing to accept snake_case `hard_blockers`.
- Added API tests for ready, preparing, missing apply target, blocked eligibility, missing PDF, stage repair, failed apply run, and missing eligibility source data.

## Verification

- `corepack pnpm api:check` - PASS.
- `corepack pnpm --filter @jobhunter/api test -- apply-audit application-feedback server` - PASS, 11 files / 207 tests.

