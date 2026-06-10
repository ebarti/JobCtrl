---
phase: 07-shared-primitive-token-migration
plan: 04
subsystem: ui
tags: [storybook, shared-ui, shadcn, accessibility, synthetic-fixtures]

requires:
  - phase: 06-token-foundation-shadcn-preset-contract
    provides: shadcn semantic token foundation and shared/ui legacy-token cleanup
provides:
  - Core primitive Storybook states for action, form, state-control, layout, feedback, and scroll primitives
  - Synthetic fixture cleanup for shared primitive stories touched by this plan
  - Verification evidence for Storybook build/test, web typecheck, token scans, deferral tracking, and whitespace checks
affects: [phase-07-shared-primitives, phase-10-storybook-a11y-qa]

tech-stack:
  added: []
  patterns:
    - Story-only primitive state coverage using existing shadcn/Radix local components
    - Generic synthetic fixtures for shared/ui Storybook examples

key-files:
  created:
    - .planning/phases/07-shared-primitive-token-migration/07-04-SUMMARY.md
  modified:
    - apps/web/src/shared/ui/button.stories.tsx
    - apps/web/src/shared/ui/input.stories.tsx
    - apps/web/src/shared/ui/textarea.stories.tsx
    - apps/web/src/shared/ui/checkbox.stories.tsx
    - apps/web/src/shared/ui/switch.stories.tsx
    - apps/web/src/shared/ui/tabs.stories.tsx
    - apps/web/src/shared/ui/card.stories.tsx
    - apps/web/src/shared/ui/skeleton.stories.tsx
    - apps/web/src/shared/ui/separator.stories.tsx
    - apps/web/src/shared/ui/scroll-area.stories.tsx

key-decisions:
  - "Kept changes story-only because no production primitive defect blocked truthful rendering."
  - "Kept the existing scroll-area a11y deferral because it maps to the tracked Radix ScrollArea backlog row."
  - "Did not change badge.stories.tsx because it already covered the supported default, secondary, destructive, and outline variants."

patterns-established:
  - "Primitive stories use generic labels, counters, helper text, and item names instead of JobHunter workflow data."
  - "Icon-only or compact primitive examples expose accessible names through aria-label or associated labels."

requirements-completed: [PRIM-01, PRIM-03, PRIM-04]

duration: 10min
completed: 2026-06-10
---

# Phase 07 Plan 04: Core Primitive Story States Summary

**Core shared primitive Storybook fixtures now expose generic action, form, state-control, layout, loading, orientation, and scroll states without new production behavior.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-06-10T10:14:47Z
- **Completed:** 2026-06-10T10:25:06Z
- **Tasks:** 2
- **Files modified:** 10 story files plus this summary

## Accomplishments

- Added Button icon-only and focus-visible stories with accessible names.
- Added Input and Textarea labeled helper, invalid, value, disabled, and focus-visible fixture coverage.
- Added Checkbox and Switch checked/off/disabled/focus examples with generic labels.
- Reworked Tabs, Card, Skeleton, Separator, and ScrollArea stories to cover active/disabled, dense content, loading stacks, orientation, and scrollable states.
- Preserved the existing ScrollArea a11y deferral and verified it remains tracked in `docs/backlog.md`.

## Task Commits

1. **Task 1: Fill action and form primitive story states** - `ef9110b` (`test`)
2. **Task 2: Fill tab, card, skeleton, separator, and scroll-area story states** - `a47b600` (`test`)

## Files Created/Modified

- `apps/web/src/shared/ui/button.stories.tsx` - Added icon-only accessible-name and focus-visible examples.
- `apps/web/src/shared/ui/input.stories.tsx` - Added label/helper, invalid, and focus-visible examples.
- `apps/web/src/shared/ui/textarea.stories.tsx` - Added label/helper, invalid, and focus-visible examples.
- `apps/web/src/shared/ui/checkbox.stories.tsx` - Added disabled-checked and focus-visible examples; replaced apply-oriented fixture copy.
- `apps/web/src/shared/ui/switch.stories.tsx` - Added disabled-off and focus-visible examples; replaced apply-oriented fixture copy.
- `apps/web/src/shared/ui/tabs.stories.tsx` - Replaced product-specific tabs with generic active, inactive, disabled, and focus examples.
- `apps/web/src/shared/ui/card.stories.tsx` - Replaced product-specific card copy and added dense content coverage.
- `apps/web/src/shared/ui/skeleton.stories.tsx` - Added card-loading and dense-row loading states.
- `apps/web/src/shared/ui/separator.stories.tsx` - Replaced apply-oriented copy and added dense toolbar orientation coverage.
- `apps/web/src/shared/ui/scroll-area.stories.tsx` - Added dense list and horizontal overflow states while keeping the tracked deferral.
- `.planning/phases/07-shared-primitive-token-migration/07-04-SUMMARY.md` - Execution summary.

## Decisions Made

- Left `badge.stories.tsx` unchanged because all supported Badge variants were already represented and adding another story would be churn.
- Kept source primitives unchanged because story rendering did not expose a production behavior or accessibility defect requiring source edits.
- Kept external `modern-web-guidance` lookup out of the execution path after the sandbox/elevation review rejected unsandboxed `npx` execution of third-party code.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Replaced non-generic primitive fixture copy**
- **Found during:** Tasks 1 and 2
- **Issue:** Existing shared primitive stories included apply/material/profile-adjacent labels such as auto-apply, dry-run apply, job detail tabs, tailored materials, and cover-letter/PDF copy. The plan required generic shared primitive stories with synthetic data only.
- **Fix:** Replaced those labels with generic primitive fixture copy while adding the planned state coverage.
- **Files modified:** `checkbox.stories.tsx`, `switch.stories.tsx`, `tabs.stories.tsx`, `card.stories.tsx`, `separator.stories.tsx`
- **Verification:** Fixture safety scans returned zero matches for prohibited sensitive/apply-oriented terms in touched story files.
- **Committed in:** `ef9110b`, `a47b600`

---

**Total deviations:** 1 auto-fixed (Rule 2)
**Impact on plan:** The fix narrowed the stories back to the plan's generic shared-ui boundary and did not expand behavior.

## Issues Encountered

- The required `modern-web-guidance` lookup failed in the sandbox because `~/.npm` cache files are not writable, and the elevated retry was rejected as unsandboxed third-party npm execution. Execution proceeded using the already-loaded repository UI/a11y contracts.
- An initial patch attempt targeted the original checkout instead of the requested `/private/tmp` worktree. The accidental five-file diff was reverted from the original checkout immediately, leaving only its pre-existing unrelated `Fable_analysis.md` untracked file. The same patch was then applied to verified absolute paths under the requested worktree.
- `corepack pnpm web:storybook:test` initially failed before running stories because Chromium could not register its macOS Mach service in the sandbox. The same command was rerun with approved elevated browser launch and passed.

## Verification

- `corepack pnpm web:check` - PASS
- `corepack pnpm web:storybook:build` - PASS after Task 1 and PASS after Task 2
- `corepack pnpm web:storybook:test` - PASS with elevated Chromium launch after sandbox denial; 89 suites, 320 tests
- Corrected legacy-token scan over `apps/web/src/shared/ui` and `apps/web/.storybook` - PASS, zero matches
- Shared/ui boundary scan - PASS for changed stories; only the known pre-existing `MarkdownDocument.tsx` operations selector exception remains
- Story deferral scan - PASS; only `scroll-area.stories.tsx` has `a11y: { test: "off" }`, mapped to `docs/backlog.md`
- `git diff --check HEAD~2..HEAD` - PASS

## Known Stubs

None.

## Threat Flags

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plan 07-04 is ready for downstream Phase 7 verification and Plan 07-05 boundary/audit work. The shared primitive story surface now has broader reviewable state coverage without production source changes.

## Self-Check: PASSED

- Verified target story files exist on disk.
- Verified task commits `ef9110b` and `a47b600` exist in git history.
- Verified the worktree has no unstaged tracked changes after task commits.
- Known unrelated untracked path remains: `.planning/research/.cache/`.

---
*Phase: 07-shared-primitive-token-migration*
*Completed: 2026-06-10*
