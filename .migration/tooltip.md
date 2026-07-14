# tooltip

2026-07-14, review-corrected 2026-07-15 — base-luma golden pair via registry plus engine, migrated the Tooltip wrapper from Radix to Base UI 1.6 while preserving the existing delay, hover/focus, accessibility, positioning, and visual contracts.

## Changed

- `apps/web/src/shared/ui/tooltip.tsx`: replaced Radix Provider/Root/Trigger/Content with Base UI Provider/Root/Trigger and the required `Portal > Positioner > Popup` structure. The popup keeps the exact existing class list and intentionally remains arrowless; the Positioner adds only the structural `isolate z-50` classes from the current base-luma golden pair.
- Provider compatibility maps `delayDuration` to `delay`, `skipDelayDuration` to `timeout`, and provider-wide `disableHoverableContent` to each Root's `disableHoverablePopup`. The existing Radix defaults remain 700 ms and 300 ms rather than changing to Base Trigger/Provider defaults of 600 ms and 400 ms. Root `delayDuration` moves to Trigger `delay`, and an explicit Base Trigger `delay` wins.
- Content positioning props are explicitly forwarded to Positioner. Existing defaults remain `positionMethod="fixed"`, `side="top"`, `align="center"`, `sideOffset={4}`, `alignOffset={0}`, `collisionPadding={0}`, and `arrowPadding={0}`; the explicit fixed default preserves Radix Popper's strategy instead of inheriting Base's absolute default. Enabled collisions explicitly use `fallbackAxisSide: "none"` plus a module-stable empty `Element[]` boundary, preserving Radix's preferred-axis-only fallback and viewport boundary instead of Base's perpendicular-end and clipping-ancestor defaults. `avoidCollisions={false}` maps to Base's all-`none` collision policy, `forceMount` maps to Portal `keepMounted`, and `hideWhenDetached` uses the Positioner's `data-anchor-hidden` state.
- Base UI 1.6 does not add Tooltip ARIA semantics itself, so the wrapper preserves Radix's accessible relationship with a stable popup ID, `role="tooltip"`, and open-only `aria-describedby` on the trigger. Existing caller-supplied `aria-describedby` values and Content IDs are retained. Consumer `onOpenChange` callbacks run before the wrapper commits its uncontrolled ARIA state, and canceled transitions do not commit.
- `apps/web/src/shared/ui/tooltip.stories.tsx` replaces Radix `asChild` composition with Base `render` composition and adds positioned offset coverage. `apps/web/src/shared/ui/tooltip.test.tsx` covers portal structure, exact classes, fixed positioning and offsets, Radix-compatible collision defaults and stable boundary identity, hover/focus/Escape behavior, canceled open/close ARIA synchronization, ARIA linkage, provider/root delay compatibility, provider hoverability, and forced mounting.
- `apps/web/src/shared/ui/base-ui-migration-boundary.test.ts` removes Tooltip from the temporary direct-Radix allowlist. `grep -n "radix-ui\|@radix-ui" apps/web/src/shared/ui/tooltip.tsx` returns no matches.

## Left alone

- `apps/web/src/main.tsx`, `apps/web/src/test/render.tsx`, and `apps/web/.storybook/preview.tsx` keep their existing `<TooltipProvider>` calls because the wrapper preserves that API.
- No production feature component directly consumes Tooltip Root, Trigger, or Content; the three pre-existing consumers are the shared stories. Other shared UI migrations and package metadata remain on their separately owned paths.

## Behavior changes

- Radix `asChild` is no longer accepted on Trigger or Content; Base UI uses `render`. All in-repository Tooltip stories have been migrated, and there are no production `asChild` consumers.
- Base Portal renders an additional `<div data-base-ui-portal>` wrapper. Positioner now owns placement styles and exposes Base's `data-side`, `data-align`, and `data-anchor-hidden` attributes; Popup exposes `data-open`/`data-closed` instead of Radix's `data-state` values. No repository consumer styles the removed Radix data attributes or tooltip CSS variables.
- Radix Content `onEscapeKeyDown` and `onPointerDownOutside` are not exposed by the compatibility wrapper. Base reports those interactions through Root `onOpenChange` event details (`escape-key` and `outside-press`), where closing can be canceled. No repository consumer uses the Content callbacks.
- Radix `sticky="partial" | "always"` is intentionally not copied to Base's unrelated boolean `sticky` prop. Base collision policy should be configured through `collisionAvoidance`; no repository consumer sets `sticky`.
- Root `onOpenChange` receives Base's second event-details argument. Existing one-argument callbacks remain valid JavaScript/TypeScript callbacks.

## Verify by hand

1. Open `Shared/UI/Tooltip/Hint`, hover and keyboard-focus the trigger, and confirm the tooltip opens immediately, remains reachable while moving the pointer toward it, and closes with Escape.
2. Open `Shared/UI/Tooltip/DisabledControl` and confirm the open tooltip remains anchored to the wrapper around the disabled button.
3. Open `Shared/UI/Tooltip/Positioned` and confirm the popup is below and start-aligned with the trigger using the visibly larger side/alignment offsets.
4. Inspect the open Hint trigger and confirm `aria-describedby` references the element with `role="tooltip"`; close it and confirm the relationship is removed.

Derived summary: 5 shared UI wrappers currently retain direct Radix imports in the shared worktree (`dialog`, `dropdown-menu`, `sheet`, `toast`, and `toggle-group`).
