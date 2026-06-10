---
phase: 06-token-foundation-shadcn-preset-contract
plan: "03"
subsystem: frontend-token-contract
tags: [tailwind-v4, shadcn, css-tokens, vitest, density]
requires:
  - phase: 06-token-foundation-shadcn-preset-contract
    plan: "02"
    provides: "Installed shadcn preset dependencies, validated aliases, and CSS-first components.json baseline"
provides:
  - "Standard shadcn semantic CSS-variable token contract for light and dark themes"
  - "Tailwind v4 CSS-first @theme inline mappings without the legacy Tailwind config bridge"
  - "App-shell density row-height variables for compact, regular, and comfy modes"
  - "Static token/config regression test for preset, theme, density, and legacy bridge absence"
affects:
  - "06-04 shared primitive token migration"
  - "06-05 overlay/menu primitive token migration"
  - "06-06 browser computed-token smoke"
tech-stack:
  added: []
  patterns:
    - "Keep semantic token values in tokens.css and Tailwind utility mappings in globals.css"
    - "Build legacy-token absence tests from fragments to avoid self-matching grep gates"
key-files:
  created:
    - "apps/web/src/styles/token-contract.test.ts"
    - ".planning/phases/06-token-foundation-shadcn-preset-contract/06-03-SUMMARY.md"
  modified:
    - "apps/web/src/styles/tokens.css"
    - "apps/web/src/styles/globals.css"
    - "apps/web/index.html"
    - "apps/web/tsconfig.json"
    - "apps/web/tailwind.config.ts"
key-decisions:
  - "Moved semantic token definitions into tokens.css and kept @theme inline mappings in globals.css so the CSS contract has one token source and one Tailwind utility bridge."
  - "Used --status-info instead of --info while keeping --success and --warning as explicit status extension tokens."
  - "Used a corrected Vitest file-filter invocation because the planned pnpm command with -- runs the whole web suite in this workspace."
patterns-established:
  - "Density remains app-shell scoped through :where(.app-shell[data-density=...]) and --jh-row-height."
  - "Tailwind config deletion requires shadcn info to report tailwindConfig '-' before completion."
requirements-completed: [TOKEN-01, TOKEN-02, TOKEN-03, TOKEN-05, TOKEN-06]
duration: 11min
completed: 2026-06-10
---

# Phase 06 Plan 03: CSS-First Token Contract Summary

**shadcn semantic tokens with Tailwind v4 CSS-first mappings, deleted legacy config bridge, and a static token regression test.**

## Performance

- **Duration:** 11 min
- **Started:** 2026-06-09T23:53:05Z
- **Completed:** 2026-06-10T00:04:24Z
- **Tasks:** 3
- **Files modified:** 6 source/config files plus this summary

## Accomplishments

- Replaced the legacy public token file with shadcn semantic variables for light and dark themes, including chart, sidebar, font, radius, and status extension tokens.
- Removed `@config` from `globals.css`, mapped the semantic tokens through Tailwind v4 `@theme inline`, and preserved JobHunter's `[data-theme="dark"]` variant.
- Preserved app-shell-scoped density through `--jh-row-height` values of compact `32px`, regular `40px`, and comfy `48px`.
- Deleted `apps/web/tailwind.config.ts` and removed it from the web TypeScript include list.
- Added `apps/web/src/styles/token-contract.test.ts` to assert token values, theme mappings, config/package pins, dark/density selectors, and legacy bridge absence.

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement CSS-first semantic tokens and density seams** - `64010bf` (`feat`)
2. **Task 2: Remove the legacy Tailwind config bridge** - `14ab682` (`chore`)
3. **Task 3: Add the token contract regression test** - `1340ec4` (`test`)

## Files Created/Modified

- `apps/web/src/styles/tokens.css` - Defines shadcn semantic light/dark tokens, status extensions, fonts, radius, and app-shell density variables.
- `apps/web/src/styles/globals.css` - Imports Tailwind, shadcn, animation CSS, Fontsource CSS, local tokens, and defines `@custom-variant dark` plus `@theme inline`.
- `apps/web/index.html` - Adds page-level `color-scheme` metadata while preserving the pre-paint `data-theme` script.
- `apps/web/tsconfig.json` - Removes the deleted Tailwind config file from includes.
- `apps/web/tailwind.config.ts` - Deleted; Tailwind utility generation now comes from CSS variables.
- `apps/web/src/styles/token-contract.test.ts` - Static Vitest coverage for the token/config contract.

## Decisions Made

- Kept token definitions in `tokens.css` and the Tailwind mapping surface in `globals.css`; this preserves the existing style entrypoint while avoiding duplicated token values.
- Mapped previous global CSS variable consumers mechanically to shadcn semantics, with muted text using `--muted-foreground` and muted surfaces using `--muted`.
- Used a corrected targeted test command, `corepack pnpm --filter @jobhunter/web test src/styles/token-contract.test.ts`, because the plan's extra `--` separator invokes the full web test suite in this repo.

## Verification

- `corepack pnpm --filter @jobhunter/web test src/styles/token-contract.test.ts` - passed; 1 file, 5 tests.
- `corepack pnpm web:check` - passed.
- `corepack pnpm dlx shadcn@latest info -c apps/web` - passed; reports Tailwind v4, `tailwindConfig -`, CSS at `src/styles/globals.css`, and aliases under `apps/web/src/shared/*`.
- `test ! -e apps/web/tailwind.config.ts` - passed.
- `corepack pnpm web:build` - passed; Vite emitted the web bundle and font assets.
- `git diff --check` - passed.
- Targeted legacy-token grep over `apps/web/src/styles`, `apps/web/components.json`, `apps/web/tsconfig.json`, and the new token test - passed with no matches.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected semantic replacement gaps before committing Task 1**
- **Found during:** Task 1 (Implement CSS-first semantic tokens and density seams)
- **Issue:** The first mechanical replacement pass left `body` on the old background token and treated all `--muted` uses as the same semantic role, which would have made muted text use the shadcn muted surface color.
- **Fix:** Converted the remaining background token to `--background` and separated muted text (`--muted-foreground`) from muted surfaces (`--muted`).
- **Files modified:** `apps/web/src/styles/globals.css`
- **Verification:** `corepack pnpm web:check`, `corepack pnpm web:build`, and targeted legacy-token grep passed.
- **Committed in:** `64010bf`

**2. [Rule 3 - Blocking] Used the working Vitest file-filter command**
- **Found during:** Task 3 (Add the token contract regression test)
- **Issue:** `corepack pnpm --filter @jobhunter/web test -- src/styles/token-contract.test.ts` runs the entire web suite in this workspace. That surfaced two unrelated pre-existing inline snapshot runner failures in `ArtifactStatusBadge.test.tsx` and `ScoreBadge.test.tsx`.
- **Fix:** Used `corepack pnpm --filter @jobhunter/web test src/styles/token-contract.test.ts`, which invokes `vitest run src/styles/token-contract.test.ts` and runs only the new token contract test.
- **Files modified:** None.
- **Verification:** Corrected targeted command passed; `corepack pnpm web:check` also passed.
- **Committed in:** Not applicable - command correction only.

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** The token implementation stayed inside the planned CSS/config/test surface. The only command deviation was a verification invocation correction; no unrelated snapshot tests were changed.

## TDD Gate Compliance

- The task frontmatter marked Task 3 as `tdd="true"`, but Tasks 1 and 2 had already implemented the token/config behavior before the regression test was added.
- The new test passed on first targeted run against the completed implementation, so there is no separate RED commit for Task 3.
- The plan still has a dedicated `test(06-03)` commit (`1340ec4`) and passing targeted verification.

## Issues Encountered

- The mandatory `modern-web-guidance` package lookup could not be run safely: sandboxed `npx` hit an npm cache permission error, and unsandboxed `npx -y modern-web-guidance@latest` was rejected as too risky. I used current official Tailwind and shadcn docs instead.
- The exact planned Vitest command with `--` ran the whole suite and failed on unrelated inline snapshot runner state. The corrected file-filter command passed.

## Auth Gates

None.

## Known Stubs

None. The only stub-pattern scan hit was the CSS `::placeholder` selector in `globals.css`, not placeholder product content or mock data.

## Threat Flags

None beyond the planned CSS token, UI preference, and build-time Tailwind trust boundaries in `06-03-PLAN.md`. This plan introduced no network endpoints, auth paths, runtime file access, schema changes, or new sensitive-data surfaces.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plans 06-04 and 06-05 can now migrate shared primitives and overlays from old utility class names to the semantic Tailwind utilities generated by `@theme inline`. The Tailwind config bridge is gone, so downstream primitive migration should treat legacy utility classes as nonfunctional styling debt, not as supported compatibility behavior.

## Self-Check: PASSED

- Found `apps/web/src/styles/token-contract.test.ts`.
- Found `.planning/phases/06-token-foundation-shadcn-preset-contract/06-03-SUMMARY.md`.
- Found task commit `64010bf`.
- Found task commit `14ab682`.
- Found task commit `1340ec4`.
- Verified `apps/web/tailwind.config.ts` is deleted.
- Verified targeted token test, `web:check`, shadcn info, `web:build`, `git diff --check`, and targeted legacy-token grep passed.

---
*Phase: 06-token-foundation-shadcn-preset-contract*
*Completed: 2026-06-10*
