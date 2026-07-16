# switch

2026-07-14, engine (base-luma golden pair consulted), migrated while retaining the wrapper's visual classes and boolean controlled/uncontrolled contract.

## Changed

- `apps/web/src/shared/ui/switch.tsx:1` swaps the Radix Root and Thumb for Base UI and translates checked, unchecked, and disabled styling to Base data attributes.
- `apps/web/src/shared/ui/switch.stories.tsx:24` adds an interactive controlled story while preserving the existing on/off and disabled stories.
- `apps/web/src/shared/ui/switch.test.tsx:20` proves uncontrolled, controlled, and disabled state attributes and callbacks.
- `apps/web/src/shared/ui/base-ui-migration-boundary.test.ts:12` removes Switch from the Radix wrapper allowlist so future direct Radix imports fail the migration boundary.
- `apps/web/src/test/setup.ts:109` supplies JSDOM's missing `PointerEvent` constructor with `MouseEvent`, because Base UI dispatches `PointerEvent` from controls. `CompensationSourcePolicyPanel.test.tsx`, the sole Switch consumer test, passes unchanged.
- `.migration/switch.md` records this focused migration.

`grep -n "radix-ui\|@radix-ui" apps/web/src/shared/ui/switch.tsx` returned no matches.

## Left alone

- `apps/web/src/contexts/scoring/components/CompensationSourcePolicyPanel.tsx` remains unchanged: its boolean `checked` and first `onCheckedChange` argument are compatible with Base UI.
- `apps/web/components.json` remains `radix-luma`: this is a progressive migration, not the final registry flip.

## Behavior changes

- Base UI renders the control as an ARIA switch span with a hidden input rather than Radix's button. Its visible geometry, controlled/uncontrolled state, and first callback argument are retained; no in-tree consumer ref depends on the old button element.
- Base UI provides event details as a second `onCheckedChange` argument. Existing one-argument consumers remain compatible.

## Verify by hand

1. Open `Shared/UI/Switch` in Storybook and toggle Off and On with click, Space, and keyboard focus.
2. Toggle Controlled and confirm state drives the thumb and track position.
3. Confirm Disabled and DisabledOff ignore click and keyboard input while retaining disabled opacity.
4. Click the label in WithLabel and confirm it focuses and toggles the switch.
