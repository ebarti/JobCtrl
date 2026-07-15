# toggle-group

2026-07-15, transformation engine, migrated to Base UI ToggleGroup plus Toggle with the existing public single/multiple wrapper API.

## Changed

- `apps/web/src/shared/ui/toggle-group.tsx`: replaced `@radix-ui/react-toggle-group` with Base UI's `ToggleGroup` and `Toggle`, retaining scalar single and array multiple values, callback shapes, disabled/orientation/loop behavior, item styling, and forwarded refs.
- `apps/web/src/shared/ui/toggle-group.tsx`: marks selected items as the initial composite tab stop and conditionally remounts a controlled single group only when its selected value changes while focus is outside the group.
- `apps/web/src/shared/ui/base-ui-migration-boundary.test.ts`: removed the migrated toggle-group wrapper from the direct Radix import allowlist.
- Leftover scan: `rg -n "radix-ui|@radix-ui" apps/web/src/shared/ui/toggle-group.tsx` is clean.

## Left alone

- `apps/web/src/shared/ui/toggle.tsx`: remains a separate, direct Radix migration unit and is intentionally untouched.
- `apps/web/src/views/jobs/JobBulkActions.tsx`: keeps the same wrapper call site and receives the compatible public API.

## Behavior changes

- Base UI represents pressed state with `data-pressed`; the wrapper also preserves the existing `data-state="on" | "off"` hook for item-level styling compatibility.

## Verify by hand

- Deferred by the requested stack-wide QA pause: verify single and multiple selection, disabled items, arrow/home/end navigation with loop on/off, vertical orientation, and an externally changed controlled single value before tabbing into the group.
