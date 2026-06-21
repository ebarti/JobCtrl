---
phase: 22-product-path-qa-safety-release
plan: "03"
subsystem: qa
tags: [frontend, jobs, compensation, playwright, a11y, safety]

requires:
  - phase: 22-product-path-qa-safety-release
    provides: 22-01 release matrix and 22-02 canonical backend/API compensation evidence
provides:
  - Projection-shaped source-conflict market compensation fixture for frontend tests
  - Jobs list unit coverage proving source-conflict warning counts remain display-only
  - Jobs drawer unit coverage proving source-conflict warning codes/messages stay inside Compensation audit
  - Seeded Playwright product-path coverage for source-conflict visibility, Apply Review handoff, and prohibited-request boundaries
affects: [phase-22, jobs-compensation-triage, compensation-audit, product-path-safety]

tech-stack:
  added: []
  patterns: [projection-shaped frontend fixtures, warning-code audit tags, seeded disposable Playwright QA]

key-files:
  created:
    - .planning/phases/22-product-path-qa-safety-release/22-03-SUMMARY.md
  modified:
    - apps/web/src/test/fixtures/projections.ts
    - apps/web/src/views/jobs/JobsView.test.tsx
    - apps/web/src/views/jobs/JobDetailDrawer.test.tsx
    - apps/web/src/contexts/enrichment/components/CompensationEvidence.tsx
    - apps/web/e2e/tests/jobs-drawer.spec.ts

key-decisions:
  - "Market warning codes are rendered beside warning messages inside the Jobs drawer Compensation audit so source-conflict evidence is inspectable without affecting Apply surfaces."
  - "Source-conflict browser QA stays seeded through JOBHUNTER_E2E_DB_PATH disposable SQLite rows and does not invoke apply, mailbox, material generation, compensation refresh, or worker-backed apply paths."

patterns-established:
  - "Frontend source-conflict fixtures use projection-shaped JobCompensationAudit data with synthetic source snapshots and no local/private/provider payloads."
  - "Jobs product-path tests assert compensation warnings are visible in Compensation audit and absent from triage, Apply readiness, Apply Review handoff mutation, sorting, filtering, and query args."

requirements-completed: [QA-01, QA-02, QA-05, QA-06]

duration: 6min
completed: 2026-06-21
---

# Phase 22 Plan 03: Frontend Product-Path Safety Evidence Summary

**Jobs list, drawer, and seeded Playwright coverage now prove source-conflict compensation evidence remains synthetic, inspectable, and warning-only.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-06-21T02:32:00Z
- **Completed:** 2026-06-21T02:37:51Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- Added `makeSourceConflictMarketCompensationAudit`, a projection-shaped frontend fixture with synthetic source snapshots, `reported_compensation_sample`, and `source_conflict_with_posted_salary`.
- Added Jobs list and drawer unit coverage for source-conflict warning counts, warning-code visibility, audit-only placement, and absence from sorting, filtering, route search, Operations query args, Apply concerns, readiness, blockers, and handoff controls.
- Updated the drawer compensation audit to render market warning codes beside their messages inside the existing warning tags.
- Extended the seeded Playwright `/jobs` path so the Director/Platform row exposes a source-conflict warning while Apply Review handoff remains jobKey-only and prohibited apply/mailbox/material/refresh requests remain absent.

## Task Commits

Each task was committed atomically:

1. **Task 1 RED: Add source conflict Jobs UI coverage** - `a3a17e4` (test)
2. **Task 1 GREEN: Render market warning codes in Jobs audit** - `663ad55` (feat)
3. **Task 2 RED: Add source conflict Jobs e2e assertions** - `e81e2a8` (test)
4. **Task 2 GREEN: Seed source conflict Jobs e2e data** - `59d87f8` (test)

## Files Created/Modified

- `apps/web/src/test/fixtures/projections.ts` - Added source-conflict market compensation audit fixture with synthetic reported-compensation sources and warning codes.
- `apps/web/src/views/jobs/JobsView.test.tsx` - Added source-conflict warning-count coverage that pins display-only sorting/filtering/query boundaries.
- `apps/web/src/views/jobs/JobDetailDrawer.test.tsx` - Added audit-only source-conflict warning coverage and fixture safety assertions.
- `apps/web/src/contexts/enrichment/components/CompensationEvidence.tsx` - Renders market warning codes with messages inside Compensation evidence.
- `apps/web/e2e/tests/jobs-drawer.spec.ts` - Added seeded source-conflict warning row, warning-only drawer assertions, Apply Review jobKey-only handoff assertion, and prohibited request watcher.
- `.planning/phases/22-product-path-qa-safety-release/22-03-SUMMARY.md` - This summary and self-check record.

## Decisions Made

- Market warnings now display canonical codes and messages only in the Compensation audit surface; posted warning rendering was left unchanged.
- Playwright safety evidence watches for prohibited non-GET requests matching apply actions, apply runs, mailbox, material generation, or compensation refresh while exercising only seeded disposable data.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Task 1 RED initially exposed missing imports in the new test assertions; those were fixed before the committed RED gate. The committed RED failure then correctly identified that market warning codes were not rendered.
- The first GREEN attempt touched the posted warning renderer; it was narrowed before commit so only market warnings changed.

## Authentication Gates

None.

## Known Stubs

None. Stub-pattern scan found existing test arrays, partial override defaults, null guards, and local test call collectors only; no placeholder UI, mock-only data path, or hardcoded empty rendering state was introduced.

## Threat Flags

None - the changes introduce no new endpoint, auth path, provider access path, schema change, file access pattern, ranking/filtering/readiness behavior, or apply/dispatch behavior. The existing Playwright seed continues to use disposable `JOBHUNTER_E2E_DB_PATH` data.

## Verification

- `corepack pnpm --filter @jobhunter/web exec vitest run src/views/jobs/JobsView.test.tsx src/views/jobs/JobDetailDrawer.test.tsx` - PASS, 46 tests.
- `corepack pnpm --filter @jobhunter/web exec vitest run src/views/jobs/JobsView.test.tsx src/views/jobs/JobDetailDrawer.test.tsx src/views/jobs/JobDetailDrawer.a11y.test.tsx` - PASS, 47 tests.
- `corepack pnpm --filter @jobhunter/web e2e -- tests/jobs-drawer.spec.ts` - PASS, 4 Playwright tests.
- `corepack pnpm web:check` - PASS.
- `git diff --check` - PASS.
- Acceptance scan for `makeSourceConflictMarketCompensationAudit`, `source_conflict_with_posted_salary`, `reported_compensation_sample`, `3 warnings`, and prohibited request watcher terms - PASS.
- Compensation sort/filter/query scan - PASS for no new compensation sort, filter, route search, or Operations query fields.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plan 22-04 can fold these passing frontend unit/a11y/e2e command results into final Phase 22 release verification. Remaining release work is documentation and final matrix sign-off, not additional frontend product behavior.

## TDD Gate Compliance

- RED gate commits present: `a3a17e4`, `e81e2a8`.
- GREEN gate commits present after RED: `663ad55`, `59d87f8`.
- No refactor commit was needed.

## Self-Check: PASSED

- Created summary file exists: `.planning/phases/22-product-path-qa-safety-release/22-03-SUMMARY.md`.
- Modified fixture/test/UI/e2e files exist.
- Task commit `a3a17e4` exists.
- Task commit `663ad55` exists.
- Task commit `e81e2a8` exists.
- Task commit `59d87f8` exists.
- No tracked file deletions were introduced by task commits.

---
*Phase: 22-product-path-qa-safety-release*
*Completed: 2026-06-21*
