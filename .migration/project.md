# project

2026-07-15, whole-project cutover, direct Radix wrappers and dependencies migrated to Base UI.

## Changed

- `apps/web/components.json`: switched the shadcn base from `radix-luma` to `base-luma` after the final wrapper migration.
- `apps/web/package.json`: removed all direct `@radix-ui/react-*` dependencies; `@base-ui/react` remains the shared primitive dependency.
- `pnpm-lock.yaml`: refreshed through the workspace package manager after the dependency removal.
- `apps/web/src/shared/ui/base-ui-migration-boundary.test.ts`: the direct-Radix wrapper allowlist is now empty.
- Shared wrappers migrated across the stacked migration changes: Button, StatCard, Label, Separator, Checkbox, Switch, Tabs, Toggle, ScrollArea, Tooltip, Popover, Select, Dialog, Sheet, DropdownMenu, Toast, and ToggleGroup.
- Direct source imports under `apps/web/src` are clean aside from the intentional Radix strings used as fixtures by the migration-boundary test.

## Left alone

- `cmdk` and `vaul` remain separate third-party libraries. Any transitive Radix packages they own are outside this direct-wrapper migration.
- User-facing redesign, adapted pipeline-operations visibility, and public documentation are later stack stages.

## Behavior changes

- Primitive-specific deltas are recorded in each `.migration/<component>.md` report.
- ToggleGroup uses a compatibility remount when a controlled single selection changes while focus is outside the group; final interaction verification is deferred.

## Verify by hand

Deferred by explicit instruction until migration, full redesign, adapted pipeline operations visibility, and documentation are all complete. The final cumulative QA pass must cover overlays, menus, selection controls, toast lifecycle, keyboard navigation, focus return, and all production page flows.
