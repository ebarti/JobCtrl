---
phase: 21-jobs-triage-ux-warning-only-floor
plan: "04"
subsystem: frontend-jobs-drawer
tags:
  - react
  - jobs-drawer
  - compensation-audit
  - tdd
  - accessibility
dependency_graph:
  requires:
    - 21-01 jobs table compensation summary DTOs
    - 21-03 compensation warning scan semantics
    - Phase 20 compensation projection/read-model contracts
  provides:
    - Jobs drawer compensation audit section
    - Warning-only compensation floor disclosure
    - Drawer/a11y regression coverage for posted, market, and floor evidence
  affects:
    - apps/web Jobs drawer
    - apps/web jobs test fixtures
    - apps/web drawer global styles
tech_stack:
  added: []
  patterns:
    - View-local React component consuming JobDetail.compensationAudit and JobSummary.compensationSummary
    - Native details/summary disclosures for source trail and confidence evidence
    - Namespaced .job-compensation-* CSS with responsive grid-to-stack behavior
key_files:
  created:
    - apps/web/src/views/jobs/JobCompensationAuditSection.tsx
    - .planning/phases/21-jobs-triage-ux-warning-only-floor/21-04-SUMMARY.md
  modified:
    - apps/web/src/test/fixtures/projections.ts
    - apps/web/src/views/jobs/JobDetailDrawer.test.tsx
    - apps/web/src/views/jobs/JobDetailDrawer.a11y.test.tsx
    - apps/web/src/views/jobs/JobDetailDrawer.tsx
    - apps/web/src/styles/globals.css
decisions:
  - Keep compensation evidence warning-only and out of Apply concerns, readiness, ranking, filtering, and dispatch controls.
  - Insert the compensation audit section immediately after JobAuditTriage and before Description.
  - Show legacy raw salary only as labeled drawer fallback context when no structured posted fact exists.
  - Use native disclosures rather than new packages or custom disclosure state.
requirements_completed:
  - UI-02
  - UI-03
  - UI-04
  - UI-05
  - UI-06
metrics:
  started_at: 2026-06-20T22:45:17Z
  completed_at: 2026-06-20T22:55:20Z
  duration: 10m03s
  tasks_completed: 3
  files_changed: 6
---

# Phase 21 Plan 04: Jobs Drawer Compensation Audit Summary

Added the Jobs drawer compensation audit section as the source-backed, warning-only salary evidence surface.

## Tasks Completed

| Task | Status | Commit | Notes |
| --- | --- | --- | --- |
| 1. RED tests and fixtures | Complete | 4199cd0 | Added synthetic posted/market/floor audit fixtures plus failing drawer and a11y assertions. RED failed as expected on the missing `Compensation audit` region. |
| 2. Drawer section implementation | Complete | 49b4b21 | Inserted `JobCompensationAuditSection` after `JobAuditTriage`, rendering posted salary evidence, market estimate evidence, source trail, confidence factors, assumptions, missing states, and floor basis. |
| 3. Styles and final checks | Complete | f61f250 | Added namespaced responsive CSS, wrapping for long warning/source text, and fixed unreachable market union arms found by typecheck. |

## What Changed

- Added a dedicated `Compensation audit` drawer section immediately after `Why this job is here` and before `Description`.
- Rendered top-level posted salary, market estimate, and floor comparison summary rows.
- Rendered separate posted, market, and floor evidence panels so posted data and market estimates remain visually distinct.
- Added source trail and confidence/assumption disclosures using native `details`/`summary`.
- Rendered explicit missing, unparseable, ambiguous, unsupported, insufficient evidence, source unavailable, not requested, not configured, and no comparable floor states.
- Preserved the v1.3 warning-only boundary with visible copy and tests proving compensation warnings do not enter Apply concerns, blockers, prerequisites, readiness, score, filters, ranking, or dispatch controls.

## Verification

| Command | Result |
| --- | --- |
| `corepack pnpm --filter @jobhunter/web test src/views/jobs/JobDetailDrawer.test.tsx` during RED | Failed as expected before implementation because the `Compensation audit` region did not exist. |
| `corepack pnpm --filter @jobhunter/web test src/views/jobs/JobDetailDrawer.test.tsx` after implementation | Passed: 14 tests. |
| `corepack pnpm --filter @jobhunter/web test src/views/jobs/JobDetailDrawer.test.tsx src/views/jobs/JobDetailDrawer.a11y.test.tsx` | Passed: 2 files, 15 tests. |
| `corepack pnpm web:check` | Passed. |
| `git diff --check` | Passed. |
| Warning-only boundary scan across Jobs view/drawer/filter/column files | Passed. `compensationAudit` and `floorComparison` are consumed only by the drawer section. |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Removed unreachable market estimate state arms**
- **Found during:** Task 3 `web:check`
- **Issue:** `MarketCompensationEstimate` does not include `not_requested`; that state belongs to the wrapper response when no estimate was requested.
- **Fix:** Removed unreachable `not_requested` switch arms from helpers that receive `MarketCompensationEstimate`.
- **Files modified:** `apps/web/src/views/jobs/JobCompensationAuditSection.tsx`
- **Commit:** f61f250

## Known Stubs

None. Stub scan found only an existing CSS `::placeholder` selector unrelated to this plan.

## Threat Flags

None. This plan added no network endpoints, auth paths, file access, schema changes, provider scraping, mailbox scanning, material generation, or destructive local-data behavior.

## Self-Check: PASSED

- Created file exists: `apps/web/src/views/jobs/JobCompensationAuditSection.tsx`
- Modified drawer insertion exists: `apps/web/src/views/jobs/JobDetailDrawer.tsx`
- RED commit found: `4199cd0`
- GREEN implementation commit found: `49b4b21`
- Style/verification commit found: `f61f250`
- Summary path exists: `.planning/phases/21-jobs-triage-ux-warning-only-floor/21-04-SUMMARY.md`
