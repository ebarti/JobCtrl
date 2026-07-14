# scroll-area

2026-07-14 — merge, migrated the customized wrapper to Base UI 1.6 with explicit Content composition and preserved visual classes.

## Changed

- `apps/web/src/shared/ui/scroll-area.tsx`: replaced the Radix parts with Base UI `Root`, `Viewport`, `Content`, `Scrollbar`, `Thumb`, and `Corner`; retained the public `ScrollArea` and `ScrollBar` exports, refs, orientations, and existing class strings. The current base-luma registry wrapper omits `Content`, so the Base 1.6 documented anatomy and migration contract were applied explicitly.
- `apps/web/src/shared/ui/scroll-area.stories.tsx`: added a tagged Chromium geometry/focus assertion for generated scrollbar CSS and Base-managed viewport focusability.
- `apps/web/src/shared/ui/scroll-area.test.tsx`: added focused composition, orientation, ref-forwarding, and overflow-dependent keyboard-focus coverage.
- `apps/web/src/shared/ui/base-ui-migration-boundary.test.ts`: removed ScrollArea from the temporary direct-Radix allowlist.
- `grep -n "radix-ui\\|@radix-ui" apps/web/src/shared/ui/scroll-area.tsx apps/web/src/shared/ui/scroll-area.stories.tsx apps/web/src/shared/ui/scroll-area.test.tsx` returns no matches.

## Left alone

- `apps/web/src/styles/globals.css`, `components.json`, package metadata, and lockfiles were intentionally left unchanged.
- Toggle, toggle-group, tabs, and unrelated shared UI wrappers remain owned by their separate migration tasks.

## Behavior changes

- The viewport is now in the tab order only while content overflows; Base UI computes `tabIndex` as `0` for scrollable content and `-1` otherwise instead of the wrapper forcing `0` for every instance.
- Base UI scrollbars remain mounted and visible whenever their axis overflows. Radix's root-level `type`, `scrollHideDelay`, `dir`, and `nonce` props are no longer available; polymorphic `asChild` becomes `render`, and scrollbar `forceMount` becomes `keepMounted`. No in-repository consumers used the removed props.

## Verify by hand

1. Open the DenseList story, focus the overflowing viewport with Tab, and use Arrow/Page keys and the mouse wheel to scroll through the rows.
2. Open HorizontalOverflow, focus the viewport, and confirm horizontal keyboard/trackpad scrolling reaches the last card.
3. Open Geometry and confirm the vertical thumb is draggable, the custom track remains 10 px wide, and the story play assertion passes in Chromium.

Derived summary: 8 shared UI wrappers remain on Radix.
