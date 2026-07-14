# toggle-group

2026-07-14, engine (base-luma golden pair consulted), migration blocked on Base UI 1.6; the parent-branch Radix implementation is retained.

## Decision

- `apps/web/src/shared/ui/toggle-group.tsx` is restored exactly to the parent-branch `@radix-ui/react-toggle-group` wrapper. No Base compatibility regression is shipped.
- `apps/web/src/shared/ui/base-ui-migration-boundary.test.ts` keeps ToggleGroup in the temporary direct-Radix allowlist.
- `apps/web/src/shared/ui/toggle-group.test.tsx` adds one focused regression for the production contract: when a mounted controlled single value changes from `active` to `deleted` without item focus, the next keyboard entry focuses the newly checked radio and makes it the sole `tabindex="0"` item.
- The migration-only ToggleGroup stories and Base-specific adapter tests were removed. Toggle's separate Base UI migration remains unchanged.

## Base UI blocker evidence

- The installed Base UI version is 1.6.0. Its public ToggleGroup declaration at `apps/web/node_modules/@base-ui/react/toggle-group/ToggleGroup.d.ts` exposes value, default value, value change, disabled, orientation, loop focus, and multiple selection, but no highlighted-index or composite-control prop.
- Base's internal `CompositeRoot` reads `data-composite-item-active` only during its first item-map initialization (`hasSetDefaultIndexRef` in `internals/composite/root/useCompositeRoot.mjs`). Its list observer watches child-list changes, not active-marker attribute changes.
- A temporary same-mount rerender probe against the Base candidate changed the checked state from `active` to `deleted`, but unchecked `active` retained `tabindex="0"` and checked `deleted` retained `tabindex="-1"`. This is production-reachable when Job views change through browser history without focusing the switcher.
- Base's `highlightedIndex` control exists only on the explicitly `@internal` Composite API and is not forwarded by ToggleGroup. Remount keys, direct DOM `tabIndex` mutation, synthetic focus, and internal-package composition were rejected because they would lose focus, diverge from Base keyboard state, create focus side effects, or depend on unsupported internals.

## Verify by hand

1. Open the Job list with the Active view selected, then change to Deleted through browser history without focusing the Job views switcher.
2. Tab into the switcher. Confirm Deleted receives focus and becomes the sole `tabindex="0"` item; Active must be unchecked with `tabindex="-1"`.
3. Use arrow keys within the switcher and confirm the Radix roving-focus behavior remains unchanged.

Derived summary: 8 shared UI wrappers remain on Radix.
