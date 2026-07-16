# checkbox

2026-07-14, engine (base-luma golden pair consulted), migrated while retaining the wrapper's visual classes and boolean controlled/uncontrolled contract.

## Changed

- `apps/web/src/shared/ui/checkbox.tsx:18` swaps the Radix parts for Base UI, translates checked and disabled styling to Base data attributes, and establishes root-owned inline-flex centering so checked and unchecked controls remain 16×16.
- `apps/web/src/shared/ui/checkbox.stories.tsx:42` adds a generated-CSS browser regression that measures both checked and unchecked geometry, alongside indeterminate, controlled, and disabled states.
- `apps/web/src/shared/ui/checkbox.test.tsx:20` proves uncontrolled, controlled, disabled, and indeterminate state attributes and callbacks.
- `apps/web/src/shared/ui/base-ui-migration-boundary.test.ts:12` removes Checkbox from the Radix wrapper allowlist so future direct Radix imports fail the migration boundary.
- `apps/web/src/test/setup.ts:109` supplies JSDOM's missing `PointerEvent` constructor with `MouseEvent`, because Base UI dispatches `PointerEvent` from controls. The existing Switch consumer test still passes with it.
- `.migration/checkbox.md` records this focused migration.

`grep -n "radix-ui\|@radix-ui" apps/web/src/shared/ui/checkbox.tsx` returned no matches.

## Left alone

- `apps/web/components.json` remains `radix-luma`: this is a progressive migration, not the final registry flip.
- No in-tree consumer imports `Checkbox`; no application call site required a prop change.

## Behavior changes

- Base UI renders the control as an ARIA checkbox span with a hidden input rather than Radix's button. Explicit inline-flex layout now preserves the original 16×16 geometry in both checked and unchecked states; no in-tree consumer ref depends on the old button element.
- Radix's `checked="indeterminate"` / `defaultChecked="indeterminate"` union is represented by Base UI's separate `indeterminate` boolean. No in-tree consumer used the legacy union; the new story and test exercise the explicit prop.

## Verify by hand

1. Open `Shared/UI/Checkbox/Geometry` in Storybook and confirm checked and unchecked controls are the same 16×16 size.
2. Toggle Default with click, Space, and keyboard focus.
3. Toggle Controlled and confirm its checked styling follows state; confirm Disabled and DisabledChecked ignore input.
4. Open Indeterminate and confirm assistive technology reports a mixed checkbox and the indicator remains visible.
5. Click the label in WithLabel and confirm focus and toggle behavior remain intact.
