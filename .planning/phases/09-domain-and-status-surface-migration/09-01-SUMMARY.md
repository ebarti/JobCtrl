---
phase: 09-domain-and-status-surface-migration
plan: 09-01
status: completed
completed: 2026-06-10
---

# 09-01 Summary: Typed Status Vocabulary

## Completed Work

- Added `apps/web/src/shared/ui/status-tokens.ts` as the shared closed vocabulary for status tag tones, status-dot states, segment-bar tones, and timeline tones.
- Tightened `StatusDot` to accept only `StatusDotState` and hide the decorative dot from assistive technology.
- Tightened `SegmentBar` to accept only `SegmentBarTone` values.
- Tightened core tone helpers for scoring tiers, artifact states, and pipeline stage states.
- Added focused tests for status dots, segment bars, score tiers, artifact status tones, job audit tones, and stage-state parity.

## Verification

- `corepack pnpm --filter @jobhunter/web test src/shared/ui/status-dot.test.tsx src/shared/ui/segment-bar.test.tsx src/contexts/scoring/lib/score-tier.test.ts src/contexts/materials/lib/artifact-status-tone.test.ts src/views/debug/activity-tone.test.ts src/contexts/operations/components/JobAuditHistory.test.tsx src/contexts/apply/components/ApplyRunTimeline.test.tsx src/contexts/apply/components/ApplyRunBadge.test.tsx src/contexts/apply/components/RunStatusBadge.test.tsx src/contexts/materials/components/ArtifactStatusBadge.test.tsx src/contexts/pipeline/components/every-stage-state-has-badge.test.tsx src/contexts/pipeline/components/StageBadge.test.tsx` - PASS, 12 files / 73 tests.
- `corepack pnpm web:check` - PASS.
- Legacy token and chart-token status audits - PASS, zero matches.

## Notes

- The vocabulary is intentionally small and product-oriented. Components that need a new lifecycle meaning must add it explicitly instead of interpolating arbitrary class names.
