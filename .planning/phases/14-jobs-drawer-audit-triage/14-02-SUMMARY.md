---
phase: 14-jobs-drawer-audit-triage
plan: 14-02
status: complete
completed: 2026-06-11
---

# 14-02 Summary: Regression Coverage And Documentation

## Implemented

- Extended the Jobs drawer regression test to assert the audit triage section answers:
  - why the job ranked the way it did
  - whether it is ready for apply review
  - which blockers or missing prerequisites exist
  - which eligibility concerns exist
  - where generated-material proof should be reviewed next
- Updated the projection fixture helper so drawer tests can override `applyAudit` and other detail fields without rebuilding the entire `JobDetail` object.
- Kept the existing drawer regression coverage passing for error handling, close/backdrop behavior, audit history placement, retry affordances, and raw next-action suppression.
- Added a local QA checklist entry for the Jobs drawer audit smoke path.

## Files

- `apps/web/src/views/jobs/JobDetailDrawer.test.tsx`
- `apps/web/src/test/fixtures/projections.ts`
- `docs/local-reliability-qa.md`

## Verification

- Targeted Jobs drawer tests passed.
- Web typecheck passed.
- Web build passed.
- Browser QA passed on a paired current-branch API and web server.
- `git diff --check` passed.

