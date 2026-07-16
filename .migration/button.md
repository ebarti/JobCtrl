# button

2026-07-14 — engine, migrated the Button Slot wrapper to Base UI's real Button primitive while preserving its exported variants and class strings.

## Changed

- `apps/web/src/shared/ui/button.tsx`: replaced the Radix Slot implementation with `@base-ui/react/button`, retaining the `Button`, `ButtonProps`, and `buttonVariants` exports and all CVA classes.
- `apps/web/src/shared/ui/button.stories.tsx` and `apps/web/src/shared/ui/button.test.tsx`: added rendered-link and native-button coverage for the Base UI composition contract.
- `apps/web/src/contexts/discovery/components/DiscoveryProductControls.tsx` and `apps/web/src/demo/guide/DemoGuide.tsx`: converted Button-owned `asChild` links to `render` targets with `nativeButton={false}`.
- `apps/web/src/shared/ui/base-ui-migration-boundary.test.ts`: removed the migrated Button wrapper from the temporary direct-Radix allowlist.
- `grep -n "radix-ui\\|@radix-ui" apps/web/src/shared/ui/button.tsx` returns no matches.

## Left alone

- Radix trigger `asChild` usage in dialogs, sheets, popovers, tooltips, and other primitives was intentionally not changed.
- `components.json`, package metadata, and the remaining Radix wrappers stay on the progressive migration path.

## Behavior changes

- `Button` now uses Base UI's `render` prop instead of `asChild`. Non-native rendered targets require `nativeButton={false}`; rendered navigation targets also set `role="link"` to retain their link semantics over Base UI's default button role.

## Verify by hand

1. Open the Button stories and confirm each variant and size preserves its current visual treatment.
2. Tab to the default Button, activate it with Enter and Space, and verify disabled buttons do not activate.
3. Open the rendered-link story and the migrated external-link controls; confirm navigation still works and focus styling remains visible.
