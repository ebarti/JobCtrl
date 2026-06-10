---
phase: 07-shared-primitive-token-migration
plan: 01
subsystem: ui
tags: [shared-ui, accessibility, storybook, shadcn, vitest]

requires:
  - phase: 06-token-foundation-shadcn-preset-contract
    provides: shadcn semantic token foundation and shared primitive token migration baseline
provides:
  - DataTable semantic table, row, columnheader, cell, sorting, selection, and activation coverage
  - ToastClose accessible-name behavior with caller override support
  - Storybook a11y deferral cleanup for fixed DataTable and toast production defects
affects: [shared-ui, storybook-a11y, primitive-accessibility]

tech-stack:
  added: []
  patterns:
    - "Colocated RTL tests for shared primitive role/name and keyboard behavior"
    - "Colocated jest-axe tests for shared primitive accessibility states"
    - "Story-owned toast viewport labels avoid duplicate Storybook landmarks while preserving runtime defaults"

key-files:
  created:
    - apps/web/src/shared/ui/data-table.test.tsx
    - apps/web/src/shared/ui/toast.a11y.test.tsx
  modified:
    - apps/web/src/shared/ui/data-table.tsx
    - apps/web/src/shared/ui/data-table.stories.tsx
    - apps/web/src/shared/ui/toast.tsx
    - apps/web/src/shared/ui/toast.stories.tsx
    - apps/web/src/shared/ui/toaster.tsx
    - apps/web/src/shared/ui/toaster.stories.tsx
    - docs/backlog.md

key-decisions:
  - "Kept DataTable props and TanStack setup unchanged while moving semantics to table, rowgroup, columnheader, row, and cell roles."
  - "Kept ToastClose on Radix Close with toast-close behavior and added a default aria-label that caller props can override."
  - "Used synthetic story/test data only and did not run user-affecting automation."

patterns-established:
  - "Shared primitive a11y fixes require both colocated regression tests and Storybook a11y gate proof before removing backlog deferrals."
  - "Storybook toast stories that render their own viewport must use a distinct synthetic viewport label when the global Storybook ToasterProvider is also mounted."

requirements-completed:
  - PRIM-01
  - PRIM-02
  - PRIM-03
  - PRIM-04

duration: 16 min
completed: 2026-06-10
---

# Phase 07 Plan 01: Repair DataTable And Toast Primitive Accessibility Summary

**DataTable and toast shared primitives now expose valid table, sorting, row activation, and close-button accessibility semantics, with Storybook a11y deferrals reduced from 13 to 10.**

## Performance

- **Duration:** 16 min
- **Started:** 2026-06-10T09:25:00Z
- **Completed:** 2026-06-10T09:40:43Z
- **Tasks:** 3 completed
- **Files modified:** 8

## Accomplishments

- Added failing-first DataTable regression tests, then repaired semantic `table`, `rowgroup`, `columnheader`, `row`, and `cell` surfaces while preserving activation, selection, and sorting callbacks.
- Added failing-first toast a11y tests, then gave `ToastClose` a default accessible name with caller override support while preserving Radix Close behavior.
- Re-enabled DataTable, Toast, and Toaster stories in the Storybook a11y bar and updated backlog accounting to 10 remaining tracked deferrals.
- Fixed the changed toast stories' duplicate `Notifications (F8)` landmark issue exposed by the Storybook test runner.

## Task Commits

1. **Task 1 RED: DataTable accessibility tests** - `f584221` (`test`)
2. **Task 1 GREEN: DataTable semantic repair** - `2b3474a` (`feat`)
3. **Task 2 RED: Toast accessibility tests** - `afb462a` (`test`)
4. **Task 2 GREEN: ToastClose accessible name** - `cc4415b` (`feat`)
5. **Task 3: Backlog deferral accounting** - `529abb1` (`docs`)
6. **Plan-level verification fix: toast story landmarks** - `048dfbc` (`fix`)

## Files Created/Modified

- `apps/web/src/shared/ui/data-table.test.tsx` - DataTable role, sorting, activation, loading, empty, and selection regression tests.
- `apps/web/src/shared/ui/data-table.tsx` - Semantic table/row/header/cell roles with row activation preserved.
- `apps/web/src/shared/ui/data-table.stories.tsx` - Removed DataTable a11y deferral and added sorted activatable synthetic state.
- `apps/web/src/shared/ui/toast.a11y.test.tsx` - ToastClose accessible-name and axe regression tests for default, destructive, and action states.
- `apps/web/src/shared/ui/toast.tsx` - Default `ToastClose` accessible name with caller override support.
- `apps/web/src/shared/ui/toast.stories.tsx` - Removed toast a11y deferral and added action/custom-close states with story-specific viewport label.
- `apps/web/src/shared/ui/toaster.tsx` - Optional viewport label for story-owned toaster proof, preserving runtime default when omitted.
- `apps/web/src/shared/ui/toaster.stories.tsx` - Removed toaster a11y deferral and used synthetic story viewport label.
- `docs/backlog.md` - Removed fixed DataTable/toast rows and updated remaining Storybook a11y deferral count to 10.

## Decisions Made

- Kept shared/ui domain-agnostic and did not add context, view, API, query, EventSource, localStorage, or clipboard imports.
- Did not migrate visible app iconography; existing local icon rendering remains scoped to the toast primitive.
- Used Storybook viewport labels only where story-owned toast viewports coexist with the global preview toaster.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Disambiguated toast story landmarks**
- **Found during:** Plan-level `corepack pnpm web:storybook:test`
- **Issue:** Removing the toast/toaster a11y deferrals exposed duplicate `Notifications (F8)` landmarks because Storybook preview mounts a global `ToasterProvider` and the changed stories also render toast viewports.
- **Fix:** Added an optional `viewportLabel` prop to `Toaster` for story-owned instances and gave direct toast stories distinct synthetic viewport labels.
- **Files modified:** `apps/web/src/shared/ui/toaster.tsx`, `apps/web/src/shared/ui/toast.stories.tsx`, `apps/web/src/shared/ui/toaster.stories.tsx`
- **Verification:** `corepack pnpm --filter @jobhunter/web test src/shared/ui/toast.a11y.test.tsx`, `corepack pnpm web:check`, `corepack pnpm web:storybook:build`, and unsandboxed `corepack pnpm web:storybook:test` passed.
- **Committed in:** `048dfbc`

---

**Total deviations:** 1 auto-fixed (Rule 3)
**Impact on plan:** The fix was required for the changed stories to re-enter the Storybook a11y gate without adding a new deferral. Runtime toast defaults remain unchanged.

## Issues Encountered

- `corepack pnpm web:storybook:test` initially failed in the sandbox before running tests because Playwright Chromium could not register its macOS Mach port. The same command was rerun outside the sandbox.
- The first unsandboxed Storybook test run then found a real changed-story duplicate-landmark failure in `toast.stories.tsx` and `toaster.stories.tsx`; this was fixed in `048dfbc`.

## Verification

- `corepack pnpm --filter @jobhunter/web test src/shared/ui/data-table.test.tsx` - PASS, 3 tests.
- `corepack pnpm --filter @jobhunter/web test src/shared/ui/toast.a11y.test.tsx` - PASS, 3 tests.
- `corepack pnpm web:check` - PASS.
- `rg -n "a11y:\\s*\\{\\s*test:\\s*\\\"off\\\"|test:\\s*\\\"off\\\"" apps/web/src/shared/ui apps/web/src/views apps/web/src/contexts docs/backlog.md` - PASS, 10 remaining story deferrals plus matching backlog count.
- `corepack pnpm web:storybook:build` - PASS, with existing bundle-size/docgen warnings only.
- `corepack pnpm web:storybook:test` - PASS after unsandboxed rerun, 88 suites and 293 tests.
- Corrected legacy-token scanner from `07-RESEARCH.md` over shared UI, shared UI stories, Storybook config, and `components.json` - PASS, `legacy token matches: 0`.
- `git diff --check` - PASS.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None.

## Threat Flags

None.

## Next Phase Readiness

Ready for Plan 07-02. The remaining 10 Storybook a11y deferrals are still tracked in `docs/backlog.md` and belong to later production or wrapper/library fixes.

## Self-Check: PASSED

- Summary file created at `.planning/phases/07-shared-primitive-token-migration/07-01-SUMMARY.md`.
- Task commits found: `f584221`, `2b3474a`, `afb462a`, `cc4415b`, `529abb1`, `048dfbc`.
- No tracked file deletions were introduced by the plan commits.
- Worktree left with only the known untracked `.planning/research/.cache/` path before summary close-out.

---
*Phase: 07-shared-primitive-token-migration*
*Completed: 2026-06-10*
