---
phase: 09-domain-and-status-surface-migration
status: verified
verified: 2026-06-10
---

# 09 Verification

## Commands

| Command | Result |
| --- | --- |
| `corepack pnpm --filter @jobhunter/web test src/shared/ui/status-dot.test.tsx src/shared/ui/segment-bar.test.tsx src/contexts/scoring/lib/score-tier.test.ts src/contexts/materials/lib/artifact-status-tone.test.ts src/views/debug/activity-tone.test.ts src/contexts/operations/components/JobAuditHistory.test.tsx src/contexts/apply/components/ApplyRunTimeline.test.tsx src/contexts/apply/components/ApplyRunBadge.test.tsx src/contexts/apply/components/RunStatusBadge.test.tsx src/contexts/materials/components/ArtifactStatusBadge.test.tsx src/contexts/pipeline/components/every-stage-state-has-badge.test.tsx src/contexts/pipeline/components/StageBadge.test.tsx` | PASS, 12 files / 73 tests |
| `corepack pnpm --filter @jobhunter/web test src/views/runs/RunsTable.test.tsx src/views/debug/DebugActivityTable.test.tsx src/contexts/scoring/components/ScoreBadge.test.tsx` | PASS, 3 files / 10 tests |
| `corepack pnpm --filter @jobhunter/web test` | PASS, 134 files / 710 tests |
| `corepack pnpm --filter @jobhunter/web test` after review fixes | PASS, 135 files / 724 tests |
| `corepack pnpm web:check` | PASS |
| `corepack pnpm web:build` | PASS, existing chunk-size warnings |
| `corepack pnpm web:storybook:build` | PASS, existing docgen/chunk warnings |
| `corepack pnpm web:storybook:test` | PASS after macOS sandbox escalation, 89 suites / 320 tests |
| `JOBHUNTER_E2E_API_PORT=8877 JOBHUNTER_E2E_WEB_PORT=5274 corepack pnpm --filter @jobhunter/web e2e -- tests/token-foundation.spec.ts` | PASS after macOS sandbox escalation, 4 Chromium tests |
| Legacy token scan for domain/status source | PASS, zero matches |
| Chart-token misuse scan for context/view/shared status source | PASS, zero matches |
| `rg -n "lucide-react" apps/web/src apps/web/package.json` | PASS, source clean; dependency retained for Phase 11 |
| `git diff --check` | PASS |

## Browser Smoke

In-app browser opened `http://127.0.0.1:5274/dashboard` against disposable seeded data under `/private/tmp/jobhunter-phase9-browser`.

DOM style inspection after route data loaded confirmed painted status selectors on:

- `/dashboard`
- `/jobs`
- `/apply-review`
- `/artifacts`
- `/runs`
- `/debug`

## Result

Phase 9 implementation verification passes. Code review and QA gates both returned PASS after the review remediation loop.
