# dropdown-menu

2026-07-15 — transformation engine with the current radix-luma/base-luma golden pair; implementation migrated to Base UI 1.6, with validation deferred by explicit instruction.

## Changed

- `apps/web/src/shared/ui/dropdown-menu.tsx`: replaced Radix DropdownMenu with Base UI Menu Root, Trigger, Portal, Positioner, Popup, Group, GroupLabel, Item, CheckboxItem/Indicator, RadioGroup, RadioItem/Indicator, Separator, SubmenuRoot, and SubmenuTrigger while preserving the exported JobCtrl names and visual class lists.
- Content now explicitly forwards positioning props through `Portal > Positioner > Popup` and retains fixed positioning, center/bottom alignment, four-pixel side offset, zero collision/arrow padding, viewport collision bounds, and no perpendicular fallback. SubContent keeps start/right/-3/0 submenu alignment.
- `apps/web/src/shared/ui/dropdown-menu.stories.tsx`: migrated Trigger composition from Radix `asChild` to Base `render`, placed menu items and labels in Groups, and exercised checkbox, radio, shortcut, disabled, and submenu composition in the existing stories.
- `apps/web/src/shared/ui/base-ui-migration-boundary.test.ts`: removed DropdownMenu from the direct-Radix allowlist. The required leftover scan was not run because validation was paused explicitly.

## Left alone

- Package metadata and lockfile remain for the final aggregate dependency cleanup.
- Dialog, Sheet, Toast, and ToggleGroup remain separately owned migration slices.
- Focused tests and all validation commands are deferred until the coordinated final QA pass.

## Behavior changes

- Radix `asChild` is replaced by Base UI `render`; the only repository call sites were migrated.
- CheckboxItem and RadioItem use Base UI's default `closeOnClick={false}` instead of Radix's close-after-selection default.
- Base callbacks add event details as a second argument; existing zero- and one-argument handlers remain compatible.
- Radix Content dismissal callback props, `textValue`, `checked="indeterminate"`, and scoped Root `dir` have no direct Base wrapper compatibility layer because there are no production consumers.
- Popup state styling and selectors use Base UI data attributes, including `data-popup-open` for submenus.

## Verify by hand

1. Open `Shared/UI/DropdownMenu/Actions`; use pointer, Arrow keys, typeahead, Enter, Escape, checkbox/radio items, and the Share submenu.
2. Confirm the popup remains trigger-anchored, focus returns to Actions after dismissal, disabled items cannot activate, and the visual surface is unchanged.

Component-local derived delta: DropdownMenu leaves the prior five-wrapper allowlist, so four wrappers remain absent concurrent slice changes (`dialog`, `sheet`, `toast`, and `toggle-group`). Final aggregate counting is deferred to coordinated QA.
