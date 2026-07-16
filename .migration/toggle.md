# toggle

2026-07-14, engine (base-luma golden pair consulted), migrated to Base UI 1.6 while retaining the wrapper's visual variants and boolean pressed contract.

## Changed

- `apps/web/src/shared/ui/toggle.tsx` replaces the Radix root with Base UI's callable Toggle and uses Base `data-pressed` / `data-disabled` state selectors.
- `apps/web/src/shared/ui/toggle.stories.tsx` covers default, pressed, controlled, disabled, outlined, sized, and focus-visible examples.
- `apps/web/src/shared/ui/toggle.test.tsx` proves controlled, uncontrolled, disabled, callback, ARIA, and Base data-attribute behavior through the shared PointerEvent harness.
- `apps/web/src/shared/ui/base-ui-migration-boundary.test.ts` removes Toggle from the temporary direct-Radix allowlist.
- `.migration/toggle.md` records this focused migration.

`grep -n "radix-ui\|@radix-ui" apps/web/src/shared/ui/toggle.tsx` returned no matches.

## Left alone

- `apps/web/components.json`, package metadata, the lockfile, and global CSS remain owned by the cumulative migration.
- No production code imports the standalone `Toggle`, so no application call site needed a prop change.

## Behavior changes

- Base UI adds event details as the second `onPressedChange` argument. Existing one-argument handlers remain compatible.
- Base UI composition uses `render` (and `nativeButton={false}` for non-buttons) instead of Radix `asChild`; there are no in-tree `Toggle` consumers using composition.
- The default native button element, `aria-pressed` state, controlled/uncontrolled behavior, disabled interaction, variants, and sizes remain unchanged.

## Verify by hand

1. Open `Shared/UI/Toggle` in Storybook and activate Default and Outline with click, Enter, and Space.
2. Confirm Pressed and Controlled expose the pressed visual state and `aria-pressed=true`.
3. Confirm Disabled ignores pointer and keyboard input while retaining disabled opacity.
4. Tab to FocusVisible and confirm the focus ring remains visible.

Derived summary: 8 shared UI wrappers remain on Radix.
