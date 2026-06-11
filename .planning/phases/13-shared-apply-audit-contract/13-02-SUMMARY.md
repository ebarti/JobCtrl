---
phase: 13-shared-apply-audit-contract
plan: 13-02
status: completed
completed_at: 2026-06-11
---

# 13-02 Summary - Apply Review Consumption

## Completed

- Replaced Apply Review's source-of-truth readiness derivation with formatting around `item.applyAudit`.
- Updated queue tags, selected header tag, queue counts, and status note to use the shared DTO.
- Added compact audit fact rendering for missing prerequisites, hard blockers, eligibility concerns, and inspectable missing/unknown sources.
- Updated synthetic web fixtures with reusable `makeApplyAudit`.
- Updated Apply Review tests for failed-run facts and missing-source facts.
- Preserved decision controls, PDF/text preview, material inspector, and in-place job-detail overlay behavior.
- Updated `docs/local-ts-api.md` and `docs/local-reliability-qa.md` with the new shared readiness contract and QA regression.

## Verification

- `corepack pnpm web:check` - PASS.
- `corepack pnpm --filter @jobhunter/web test src/views/apply-review/ApplyReviewView.test.tsx src/views/jobs/JobDetailDrawer.test.tsx` - PASS, 2 files / 16 tests.
- `corepack pnpm web:build` - PASS with the existing Vite large-chunk warning.

