# stat-card

2026-07-14 — engine, migrated the StatCard Slot composition to Base UI `useRender` and `mergeProps` while preserving the card layout and tone variants.

## Changed

- `apps/web/src/shared/ui/stat-card.tsx`: replaced Radix Slot/Slottable with Base UI render composition, preserving the existing card, label, value, delta, and tone class strings.
- `apps/web/src/shared/ui/stat-card.stories.tsx` and `apps/web/src/shared/ui/stat-card.test.tsx`: converted the link story to `render` and added composition coverage for content, classes, and click handlers.
- `apps/web/src/views/dashboard/KpiGrid.tsx`: converted the interactive KPI StatCard from `asChild` to a childless `render` anchor.
- `apps/web/src/shared/ui/base-ui-migration-boundary.test.ts`: removed the migrated StatCard wrapper from the temporary direct-Radix allowlist.
- `grep -n "radix-ui\\|@radix-ui" apps/web/src/shared/ui/stat-card.tsx` returns no matches.

## Left alone

- Non-interactive StatCard consumers retain their existing direct-div rendering.
- Other Radix Slot wrappers and trigger `asChild` usages remain outside this component migration.

## Behavior changes

- The StatCard polymorphic API is now `render={<a ... />}` rather than `asChild` with a child anchor. The supplied render target must remain childless so StatCard can provide the full stat layout.

## Verify by hand

1. Open the StatCard stories and confirm tone, spacing, and card-surface visuals match the existing variants.
2. Open a dashboard KPI card with keyboard focus and activate it; confirm it navigates to the same filtered jobs view.
3. Confirm the rendered-link StatCard exposes the full label, value, and delta as one clickable anchor.
