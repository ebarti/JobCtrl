---
phase: 13-shared-apply-audit-contract
status: pass
verified_at: 2026-06-11
---

# Phase 13 Verification

## Result

PASS.

## Requirements

- AUDIT-01: PASS. `ApplyAudit` defines state, label, summary, missing prerequisites, hard blockers, eligibility concerns, source metadata, and review-evidence availability.
- AUDIT-02: PASS. `buildApplyAudit` derives the DTO at the API/read-model layer from application target, material availability, stage state/error, latest apply run, score eligibility, and review-evidence availability.
- AUDIT-03: PASS. `ApplyReviewQueueItem` and `JobDetail` expose `applyAudit`.
- AUDIT-04: PASS. Apply Review consumes `item.applyAudit` for readiness tags, counts, and status explanation; local helpers only format DTO facts.
- AUDIT-05: PASS. Missing prerequisites, hard blockers, eligibility unknowns, and missing/unknown source rows render as explicit text facts.
- AUDIT-06: PASS. API and web tests cover ready, preparing, missing apply link, missing resume/PDF, blocked eligibility, failed/stale-like repair states, failed apply run, and missing eligibility source data.

## Commands

- `corepack pnpm api:check` - PASS.
- `corepack pnpm --filter @jobhunter/api test -- apply-audit application-feedback server` - PASS, 11 files / 207 tests.
- `corepack pnpm web:check` - PASS.
- `corepack pnpm --filter @jobhunter/web test src/views/apply-review/ApplyReviewView.test.tsx src/views/jobs/JobDetailDrawer.test.tsx` - PASS, 2 files / 16 tests.
- `corepack pnpm web:build` - PASS with existing Vite large-chunk warning.
- `git diff --check` - PASS.

## Browser QA

Opened `http://localhost:5174/apply-review` in the in-app browser and verified:

- Queue metadata rendered `33 ready · 0 preparing · 0 need repair`.
- The selected application was `Director of Engineering`.
- The selected header tag rendered `materials ready`.
- The selected status note rendered `The tailored materials are ready to review before approval.`
- The first queue items rendered `materials ready`, not the prior stale `materials not ready` label.

No apply/browser automation, mailbox scanning, generated-material regeneration, destructive profile/database action, or worker-backed job was run.

