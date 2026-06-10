---
phase: 08-layout-chrome-fonts-and-tabler-icons
plan: "01"
subsystem: frontend-shell
tags: [app-shell, shadcn, tokens, fonts, density]
requires:
  - phase: 07-shared-primitive-token-migration
    provides: shared primitive semantic-token baseline
provides:
  - Tokenized app shell, topbar, nav, tabs, search, select, and connection chrome
  - Preserved Geist, JetBrains Mono, and app-shell density seams
  - Static shell token assertions in the token contract test
affects: [phase-08, app-shell, topbar, density, theme]
requirements-completed: [LAYOUT-01, LAYOUT-02, LAYOUT-04, LAYOUT-05]
duration: 9min
completed: 2026-06-10
---

# Phase 08 Plan 01: Shell Token And Font Summary

The app shell chrome now consumes shadcn semantic tokens while preserving the existing route, search, theme, density, and connection-status behavior.

## Accomplishments

- Retokenized `.topbar`, brand, nav, route tabs, global search, select/input chrome, connection pill, and status banners in `apps/web/src/styles/globals.css`.
- Preserved `.app-shell[data-density]` as the density root and kept `--jh-row-height` values for compact, regular, and comfy modes.
- Kept Fontsource Geist and JetBrains Mono imports and the `--jh-font-*` mappings unchanged.
- Extended `apps/web/src/styles/token-contract.test.ts` so shell chrome, font, and density selectors remain part of the static contract.

## Verification

- `corepack pnpm --filter @jobhunter/web test src/shared/layout/Topbar.test.tsx src/shared/layout/ThemeToggle.test.tsx src/shared/layout/ConnectionStatusPill.test.tsx src/styles/token-contract.test.ts src/shared/ui/filterable-data-grid.test.tsx src/shared/ui/toast.a11y.test.tsx src/shared/ui/table-pager.test.tsx` - PASS, 7 files / 26 tests.
- `corepack pnpm web:check` - PASS.
- `corepack pnpm web:build` - PASS.
- `git diff --check` - PASS.

## Deviations

None. The implementation stayed within visual shell selectors and static contract tests.
