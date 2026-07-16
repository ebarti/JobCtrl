# popover

2026-07-15 — current radix-luma/base-luma golden pair plus the transformation engine, migrated the Popover wrapper to Base UI 1.6 and hardened its outside-interaction bridge against Base's native event timing.

## Changed

- `apps/web/src/shared/ui/popover.tsx`: replaced the direct Radix import with Base UI `Root`, `Trigger`, `Portal`, `Positioner`, `Popup`, `Arrow`, and `Close`. The original `Popover`, `PopoverTrigger`, `PopoverAnchor`, and `PopoverContent` exports remain, and the Base structural parts are also exported as `PopoverPortal`, `PopoverPositioner`, `PopoverPopup`, `PopoverArrow`, and `PopoverClose`.
- The focused Content adapter keeps the existing `align="center"`, `side="bottom"`, `sideOffset={4}`, fixed positioning, zero collision/arrow padding, no perpendicular-axis fallback, `sticky="partial"`, portal container, forced mounting, detached-anchor hiding, and exact popup visual class list. Its stable empty collision-boundary array retains Radix's viewport/root-boundary default instead of inheriting Base's clipping-ancestor default when a custom portal container clips overflow. Radix `sticky="always"` maps to Base `sticky={true}`; `avoidCollisions={false}` maps to Base's all-`none` collision policy.
- `PopoverAnchor` remains a real compatibility part. It registers its rendered element with Base Positioner, supports both Radix `asChild` and Base `render` composition without an extra DOM wrapper, and yields to an explicit Content `anchor` prop.
- Autofocus and dismissal callbacks remain cancelable. Actual Base `pointerdown` and focus-out transitions receive cancelable Radix-shaped custom events with `detail.originalEvent`. Base outside presses reported from another native phase receive a truthful cancelable `popover.outsidePress` event through `onInteractOutside`; preventing any compatibility event cancels Base Root's close transition. Root open callbacks retain their first boolean argument and may also inspect Base's event details.
- Modal content includes a screen-reader-only Base Close control so Base UI's modal and `trap-focus` modes retain an accessible escape path and actually enable focus trapping.
- `apps/web/src/shared/ui/popover.stories.tsx`: migrated the existing stories to Base `render` composition and added a controlled modal/Close/positioning story.
- `apps/web/src/shared/ui/popover.test.tsx`: covers custom-anchor geometry, fixed placement and offsets, viewport versus clipping-ancestor behavior in a custom portal container, portal structure, retained classes, old `asChild` composition, controlled callbacks, initial/final focus, Close, prevented Escape/focus-out/outside-press dismissal, real focusable outside-click ordering with and without cancellation, native pointerdown-versus-click event types, forced mounting, and the modal escape control.
- `apps/web/src/shared/ui/base-ui-migration-boundary.test.ts`: removed Popover from the temporary direct-Radix allowlist. `grep -n "radix-ui\|@radix-ui" apps/web/src/shared/ui/popover.tsx apps/web/src/shared/ui/popover.test.tsx apps/web/src/shared/ui/popover.stories.tsx` returns no matches.

## Left alone

- Repository-wide consumer inspection found no production import of the shared Popover and no production `PopoverAnchor` consumer; the pre-existing consumers are the shared stories. No application call site required migration.
- `apps/web/components.json`, package metadata, lockfiles, global CSS, and other shared UI migrations remain on their separately owned slices.

## Behavior changes

- Base Portal renders an additional `<div data-base-ui-portal>` and Positioner DOM layer. Positioner and Popup expose Base `data-open`, `data-closed`, `data-side`, and `data-align` attributes instead of Radix Content's `data-state`; no repository consumer targets the removed DOM shape, attributes, or Radix Popper CSS variables.
- Base UI's modal focus manager requires a Close part. Modal Content therefore gains a screen-reader-only `Close popover` button in addition to any visible close control supplied by a caller.
- Base UI 1.6's public Popover Root API exposes no initiating pointerdown event or dismissal-timing option for the default nonmodal mouse path. A real click on a focusable outside target reports `focus-out` first and then `outside-press` from the final native `click`; a non-focus-moving target reports only the final click. The adapter therefore never relabels either event as Radix `onPointerDownOutside`: `onInteractOutside` receives a cancelable Radix-shaped focus event first, then a cancelable `popover.outsidePress` event whose `detail.originalEvent` truthfully contains Base's `MouseEvent | PointerEvent | TouchEvent`. Base also calls Root `onOpenChange(false, …)` for both uncanceled phases of that one focusable click. Preventing `onInteractOutside` cancels both phases, but a caller using only `onPointerDownOutside` cannot observe or cancel this default Base path. Caching the earlier DOM pointerdown was rejected because correctly identifying associated triggers, nested portals/branches, drag-outs, and Radix's deferred touch-click behavior would duplicate unsupported outside-detection internals. When Base itself reports an actual `pointerdown` (for example, trap-focus's sloppy mouse path), both Radix-shaped callbacks still run in Radix order and share the same cancelable event. This widens `onInteractOutside`'s event union; no repository consumer uses either callback.
- `onOpenAutoFocus` and `onCloseAutoFocus` retain their cancelable focus-policy behavior, but the compatibility callback receives a synthetic `Event` whose `target`/`currentTarget` are `null` rather than Radix's event dispatched from Content. No repository consumer uses either callback.
- Radix Anchor's unused `virtualRef` prop and Content's unused `onPlaced` and `updatePositionStrategy` props have no exact Base 1.6 adapter equivalent and are not exposed. Base's explicit Content `anchor`, `positionMethod`, and `disableAnchorTracking` props cover current positioning needs; no repository consumer used the removed props.
- Base Root `onOpenChange` receives a second event-details argument. Existing one-argument callbacks remain compatible.

## Verify by hand

1. Open `Shared/UI/Popover/FilterPicker`; activate the trigger by pointer and keyboard, confirm the popup opens start-aligned below it, and dismiss it with Escape and clicks on both focusable and non-focusable outside content.
2. Open `Shared/UI/Popover/OpenByDefault`; confirm the popup surface, border, foreground, width, and shadow match the existing visual treatment and focus enters the popup content.
3. Open `Shared/UI/Popover/ControlledModal`; open and close it with the trigger, visible Close button, Escape, and keyboard focus. Confirm focus is trapped while open, returns to the trigger on close, and the state label follows the controlled Root.
4. Inspect the controlled popup and confirm it is right-positioned with the requested offset, has `role="dialog"`, and exposes an accessible `Close popover` escape control.

Derived summary: 5 shared UI wrappers currently retain direct Radix imports in the shared worktree (`dialog`, `dropdown-menu`, `sheet`, `toast`, and `toggle-group`).
