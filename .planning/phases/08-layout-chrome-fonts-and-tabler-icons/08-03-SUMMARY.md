---
phase: 08-layout-chrome-fonts-and-tabler-icons
plan: "03"
subsystem: frontend-shell-tests
tags: [vitest, topbar, theme, density, connection-status]
requires:
  - phase: 08-layout-chrome-fonts-and-tabler-icons
    plan: "01"
    provides: tokenized shell chrome
  - phase: 08-layout-chrome-fonts-and-tabler-icons
    plan: "02"
    provides: Tabler shell/shared icon migration
provides:
  - Focused Topbar behavior regression tests
  - ThemeToggle accessible-name and persistence behavior tests
  - ConnectionStatusPill live-region and warning-banner tests
affects: [phase-08, app-shell, ui-preferences, connection-status]
requirements-completed: [LAYOUT-01, LAYOUT-02, LAYOUT-03, LAYOUT-04]
duration: 12min
completed: 2026-06-10
---

# Phase 08 Plan 03: Shell Behavior Test Summary

Focused tests now prove the Phase 8 visual and icon migration did not change global search, theme toggle, density control, or connection-status behavior.

## Accomplishments

- Added `Topbar.test.tsx` covering visible nav labels, blank-search no-op behavior, trimmed `/jobs?q=...&page=1` navigation, and density store updates.
- Added `ThemeToggle.test.tsx` covering the button accessible name and persisted theme store/html theme updates.
- Added `ConnectionStatusPill.test.tsx` covering live `aria-live`, worker-missing alert behavior, and long closed event-stream offline banner behavior under fake timers.
- Kept tests synthetic and in-memory; no API server, worker, EventSource, mailbox, apply, or material-generation path was invoked.

## Verification

- `corepack pnpm --filter @jobhunter/web test src/shared/layout/Topbar.test.tsx src/shared/layout/ThemeToggle.test.tsx src/shared/layout/ConnectionStatusPill.test.tsx src/styles/token-contract.test.ts src/shared/ui/filterable-data-grid.test.tsx src/shared/ui/toast.a11y.test.tsx src/shared/ui/table-pager.test.tsx` - PASS, 7 files / 26 tests.
- `corepack pnpm web:check` - PASS.
- `git diff --check` - PASS.

## Deviations

None. Long disconnect behavior was practical to cover in Vitest with fake timers, so no unit-test gap was deferred to browser proof.
