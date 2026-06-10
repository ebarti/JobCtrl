---
phase: 08-layout-chrome-fonts-and-tabler-icons
plan: "02"
subsystem: frontend-icons
tags: [tabler, icons, shared-ui, app-shell]
requires:
  - phase: 08-layout-chrome-fonts-and-tabler-icons
    plan: "01"
    provides: tokenized shell chrome baseline
provides:
  - Tabler icons for shell and shared primitive affordances
  - Explicit lucide deferral ledger for domain and view components
affects: [phase-08, shared-ui, app-shell, phase-09, phase-11]
requirements-completed: [LAYOUT-01, LAYOUT-03]
duration: 7min
completed: 2026-06-10
---

# Phase 08 Plan 02: Tabler Shell Icon Summary

Shell and shared primitive affordance icons now use the configured Tabler icon package. Remaining lucide imports are documented as domain/view deferrals rather than mixed chrome drift.

## Accomplishments

- Migrated `ThemeToggle` from lucide `Moon`/`Sun` to Tabler `IconMoon`/`IconSun` while preserving the existing accessible name and decorative icon semantics.
- Migrated shared primitive icons in command, select, dropdown-menu, checkbox, dialog, sheet, toast, copyable command, and filterable data grid to Tabler equivalents.
- Preserved existing class names, dimensions, labels, Radix/cmdk composition, and primitive behavior.
- Created `08-ICON-AUDIT.md` with migrated mappings, remaining lucide imports, deferral reasons, and dependency cleanup ownership.

## Verification

- `corepack pnpm --dir apps/web exec node -e "const icons=require('@tabler/icons-react'); for (const n of ['IconMoon','IconSun','IconSearch','IconCheck','IconChevronDown','IconChevronUp','IconChevronRight','IconCircle','IconCopy','IconX','IconFilter','IconSortAscending','IconSortDescending','IconTable']) if (!icons[n]) throw new Error(n)"` - PASS.
- `corepack pnpm --filter @jobhunter/web test src/shared/ui/filterable-data-grid.test.tsx src/shared/ui/toast.a11y.test.tsx src/shared/ui/table-pager.test.tsx` - PASS as part of the 7-file Phase 8 test command.
- `! rg -n "lucide-react" apps/web/src/shared/ui apps/web/src/shared/layout` - PASS, zero matches.
- `rg "lucide-react|@tabler/icons-react" apps/web/src apps/web/package.json` - PASS, audit recorded expected Tabler imports and deferred lucide imports.
- `corepack pnpm web:check` - PASS.

## Deviations

No new icon package was added. Domain/view icons were intentionally left for Phase 9 or Phase 11 unless their semantics are covered in this phase.
