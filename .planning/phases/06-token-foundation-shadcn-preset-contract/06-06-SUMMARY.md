---
phase: 06-token-foundation-shadcn-preset-contract
plan: "06"
subsystem: frontend-token-qa
tags: [tailwind-v4, shadcn, playwright, docs, qa, semantic-tokens]
requires:
  - phase: 06-token-foundation-shadcn-preset-contract
    plan: "04"
    provides: "Core primitive semantic utility migration"
  - phase: 06-token-foundation-shadcn-preset-contract
    plan: "05"
    provides: "Overlay/menu primitive semantic utility migration"
provides:
  - "Browser computed-token smoke for light/dark shadcn tokens and app-shell density"
  - "Frontend architecture and QA docs updated for the CSS-first shadcn token contract"
  - "Final Phase 6 proof gate with typecheck, build, shadcn info, generated CSS, legacy scan, browser smoke, and diff hygiene"
affects:
  - "Phase 7 shared primitive migration can start from a grep-clean Phase 6 token foundation"
tech-stack:
  added: []
  patterns:
    - "Use seeded Playwright E2E for browser token proof and avoid user-affecting automation"
    - "Verify generated Tailwind utilities from built CSS instead of assuming compile-only token validity"
key-files:
  created:
    - "apps/web/e2e/tests/token-foundation.spec.ts"
    - ".planning/phases/06-token-foundation-shadcn-preset-contract/06-06-SUMMARY.md"
  modified:
    - "apps/web/src/shared/ui/scroll-area.tsx"
    - "apps/web/src/shared/ui/separator.tsx"
    - "docs/frontend-target.md"
    - "docs/local-reliability-qa.md"
key-decisions:
  - "Validated browser token behavior with seeded Playwright data only: no auto-apply, browser submission, mailbox scan, real material generation, destructive action, or worker-backed job was run."
  - "Treated standard shadcn `bg-muted` and `text-muted-foreground` as valid while rejecting old token utilities and bare legacy `text-muted`."
  - "Verified the ring token through emitted focus/focus-visible ring selectors because Tailwind did not emit an unused bare `.ring-ring` selector."
patterns-established:
  - "Phase token QA includes token-contract unit test, web typecheck, production build, shadcn info, generated CSS utility proof, legacy-token scan, seeded browser smoke, and diff hygiene."
requirements-completed: [TOKEN-01, TOKEN-02, TOKEN-03, TOKEN-04, TOKEN-05, TOKEN-06]
duration: 14min
completed: 2026-06-10
---

# Phase 06 Plan 06: Browser Proof, Docs, And Final Gate Summary

**Phase 6 now has browser-level proof for the shadcn token foundation and is closed with a passing final proof gate.**

## Performance

- **Duration:** 14 min
- **Completed:** 2026-06-10
- **Tasks:** 3
- **Files modified:** 5 source/docs files plus this summary

## Accomplishments

- Added `apps/web/e2e/tests/token-foundation.spec.ts`, a seeded Playwright smoke that verifies non-empty root shadcn tokens, light/dark `color-scheme`, theme switching, app-shell density values `32px`, `40px`, `48px`, topbar/nav/native select styling, focus visibility, and `/jobs` rendering under the same shell.
- Updated `docs/frontend-target.md` to describe the Tailwind CSS 4 CSS-first token target: `@theme inline`, `shadcn/tailwind.css`, `tw-animate-css`, Fontsource Geist and JetBrains Mono imports, `[data-theme="dark"]`, and app-shell-scoped density variables.
- Updated `docs/local-reliability-qa.md` with the token foundation QA gate, generated CSS proof requirement, seeded browser proof requirement, and no user-affecting automation boundary.
- Removed the last two production legacy primitive utilities found by the final scan: `bg-rule-2` in `scroll-area.tsx` and `bg-rule` in `separator.tsx`.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add browser computed-token smoke** - `fe78dfd` (`test`)
2. **Task 2: Update owning frontend and QA docs narrowly** - `3fad1e8` (`docs`)
3. **Task 3: Remove remaining legacy primitive tokens from final proof scan** - `c7bd768` (`fix`)

## Files Created/Modified

- `apps/web/e2e/tests/token-foundation.spec.ts` - Browser computed-token smoke for root tokens, theme, density, focus, topbar/nav/native select styling, and dense route rendering.
- `docs/frontend-target.md` - Styling target now reflects Tailwind CSS 4 CSS-first token mappings and the current shadcn token contract.
- `docs/local-reliability-qa.md` - Frontend QA now includes the token foundation proof gate and safe seeded-browser boundary.
- `apps/web/src/shared/ui/scroll-area.tsx` - Scrollbar thumb now uses `bg-border` instead of legacy `bg-rule-2`.
- `apps/web/src/shared/ui/separator.tsx` - Separator now uses `bg-border` instead of legacy `bg-rule`.

## Verification

- `corepack pnpm --filter @jobhunter/web test src/styles/token-contract.test.ts` - passed: 1 file, 5 tests.
- `corepack pnpm web:check` - passed.
- `corepack pnpm web:build` - passed; Vite emitted the existing chunk-size warning for large bundles.
- `corepack pnpm dlx shadcn@latest info -c apps/web` - passed; Tailwind v4 detected, no Tailwind config file, `src/styles/globals.css` as Tailwind CSS, aliases resolved under `apps/web/src/shared/ui`, icon library set to Tabler.
- `test ! -e apps/web/tailwind.config.ts` - passed.
- Generated CSS utility proof - passed: `bg-background`, `text-foreground`, `bg-card`, `border-border`, `bg-primary`, `text-primary-foreground`, `bg-popover`, and `text-popover-foreground` present; emitted focus/focus-visible `ring-ring` variants present.
- Phase-wide legacy-token scanner over `apps/web/src`, `apps/web/.storybook`, and `apps/web/components.json` - passed with `legacy token matches: 0`.
- `corepack pnpm --filter @jobhunter/web e2e -- tests/token-foundation.spec.ts` with isolated E2E ports and `/private/tmp/jobhunter-e2e-token-foundation` - passed: 1 Chromium test.
- `rg -n "@theme inline|shadcn/tailwind.css|token foundation|data-theme|density" docs/frontend-target.md docs/local-reliability-qa.md` - passed with expected doc hits.
- `git diff --check` - passed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Corrected the token-contract Vitest file-filter command**
- **Found during:** Task 3 verification
- **Issue:** The planned command `corepack pnpm --filter @jobhunter/web test -- src/styles/token-contract.test.ts` ran the full web suite in this workspace and hit unrelated inline snapshot runner failures in `ScoreBadge.test.tsx` and `ArtifactStatusBadge.test.tsx`.
- **Fix:** Used the working file-filter form: `corepack pnpm --filter @jobhunter/web test src/styles/token-contract.test.ts`.
- **Files modified:** `docs/local-reliability-qa.md` records the working command.
- **Verification:** Corrected command passed: 1 file, 5 tests.
- **Committed in:** `3fad1e8`.

**2. [Rule 3 - Blocking] Rebuilt API native sqlite module for current Node ABI before browser setup**
- **Found during:** Browser smoke setup
- **Issue:** Playwright global setup failed before browser launch because `better-sqlite3` had been compiled for Node module ABI 141 while the active Node runtime required ABI 127.
- **Fix:** Ran `corepack pnpm --filter @jobhunter/api rebuild better-sqlite3` and verified `corepack pnpm --filter @jobhunter/api exec node -e 'require("better-sqlite3")'` loaded successfully.
- **Files modified:** None committed; this repaired local `node_modules` only.
- **Verification:** Subsequent Playwright setup seeded the disposable E2E app directory successfully.
- **Committed in:** Not applicable.

**3. [Rule 3 - Blocking] Reran Playwright outside the sandbox after Chromium launch was denied**
- **Found during:** Browser smoke setup after native rebuild
- **Issue:** Chromium failed to launch under the sandbox with `MachPortRendezvousServer... Permission denied`.
- **Fix:** Reran the same targeted E2E command with approved unsandboxed browser execution.
- **Files modified:** None.
- **Verification:** `token-foundation.spec.ts` passed: 1 Chromium test.
- **Committed in:** Not applicable.

**4. [Rule 3 - Blocking] Corrected generated CSS proof for ring utility emission**
- **Found during:** Generated CSS proof
- **Issue:** Tailwind emitted `ring-ring` only in used focus/focus-visible variants; it did not emit an unused bare `.ring-ring` selector.
- **Fix:** Required the actual emitted focus/focus-visible `ring-ring` selectors in the generated CSS proof.
- **Files modified:** None - verification command correction only.
- **Verification:** Generated CSS proof passed with all required selectors and ring variant present.
- **Committed in:** Not applicable.

**5. [Rule 3 - Blocking] Removed final legacy primitive utilities found by the phase-wide scan**
- **Found during:** Phase-wide legacy-token scan
- **Issue:** `scroll-area.tsx` still used `bg-rule-2` and `separator.tsx` still used `bg-rule`.
- **Fix:** Replaced both with `bg-border`.
- **Files modified:** `apps/web/src/shared/ui/scroll-area.tsx`, `apps/web/src/shared/ui/separator.tsx`
- **Verification:** Phase-wide legacy-token scanner passed with `legacy token matches: 0`; web typecheck and browser smoke passed after cleanup.
- **Committed in:** `c7bd768`.

---

**Total deviations:** 5 auto-fixed (5 blocking corrections)
**Impact on plan:** The final implementation remains within Phase 6 scope. The only source cleanup beyond the planned E2E/docs work was required to satisfy the Phase 6 clean-slate legacy-token exit gate.

## Issues Encountered

- The planned no-match regex grep form was replaced by a deterministic scanner because earlier no-match `rg` invocations hung in this sandbox. The scanner covers the same app/story/config surface and prints an explicit match count.
- `shadcn info` reports a generated preset URL/code for the subset of preset options the CLI can encode, but the local config and tokens still carry the Phase 6 decoded preset contract from the milestone.

## Auth Gates

None.

## Known Stubs

None. The browser smoke uses the existing Playwright seeded E2E harness and synthetic fixture data.

## Threat Flags

None. The plan did not run auto-apply, browser submission, mailbox scanning, real material generation, destructive profile/database actions, or worker-backed jobs. The E2E run used a disposable temp app directory.

## User Setup Required

None. If E2E is run from a Node version different from the one that last installed dependencies, rebuild `better-sqlite3` for the active Node runtime first.

## Next Phase Readiness

Phase 7 can proceed from a Phase 6 token foundation that has passing typecheck, build, shadcn CLI validation, generated CSS proof, legacy-token scan, and seeded browser proof. Phase 7 should focus on remaining shared primitive breadth, Storybook states, and a11y coverage rather than reintroducing compatibility aliases.

## Self-Check: PASSED

- Found `.planning/phases/06-token-foundation-shadcn-preset-contract/06-06-SUMMARY.md`.
- Found task commit `fe78dfd`.
- Found task commit `3fad1e8`.
- Found task commit `c7bd768`.
- Verified token-contract test, web typecheck, web build, shadcn info, Tailwind config absence, generated CSS utility proof, phase-wide legacy scanner, seeded Playwright token smoke, docs grep, and diff hygiene.

---
*Phase: 06-token-foundation-shadcn-preset-contract*
*Completed: 2026-06-10*
