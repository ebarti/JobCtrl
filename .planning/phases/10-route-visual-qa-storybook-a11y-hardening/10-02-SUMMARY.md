---
phase: 10-route-visual-qa-storybook-a11y-hardening
plan: 10-02
status: completed
completed_at: 2026-06-10T14:22:43Z
---

# 10-02 Density, Focus, Overlay, And Control QA - Summary

## Completed

- Extended the route QA spec to cover compact, regular, and comfy density modes on table/list-heavy routes.
- Verified keyboard focus visibility for app chrome, filters, form controls, tabs, and destructive controls.
- Exercised job detail, artifact detail, and workflow run drawer overlays with keyboard dismissal.
- Added a focused shared primitive regression test proving `Input` and `Textarea` no longer suppress the app-level `:focus-visible` outline.
- Fixed a discovered Jobs route regression where unrelated background preparation pickup could disable selected-row bulk actions.

## Evidence

- `corepack pnpm --filter @jobhunter/web test src/views/jobs/JobsView.test.tsx src/shared/ui/input.test.tsx` passed: 2 files, 21 tests.
- `JOBHUNTER_E2E_APP_DIR=/private/tmp/jobhunter-phase10-e2e-bulk JOBHUNTER_E2E_API_PORT=8879 JOBHUNTER_E2E_WEB_PORT=5276 corepack pnpm --filter @jobhunter/web e2e -- tests/jobs-bulk.spec.ts` passed: 1 Chromium test.
- In-app browser check passed against a disposable local stack on ports 8880/5277: `/jobs` loaded seeded data, 4 selectable rows were present, `3 selected` was visible, `delete selected` was enabled, and browser console error logs were empty.

## Root Cause

The Jobs bulk bar received a broad `loading` flag that combined bulk mutations, query fetching, and automatic background stage pickup. Seeded QA rows can trigger preparation pickup as the page loads, so selected-row destructive actions were disabled even though the selection state was valid. The fix narrows the bulk-action disabled state to actual bulk mutations.
