# select

2026-07-14 — engine with the current base-luma golden pair as the structural reference; migrated the customized Select wrapper from Radix to Base UI 1.6 while preserving its string-value API, formatted labels, popper defaults, styling, and production source-policy flow.

## Changed

- `apps/web/src/shared/ui/select.tsx:1`: replaced the direct Radix import with Base UI `Root`, `Trigger`, `Value`, `Icon`, `Portal`, `Positioner`, `Popup`, `List`, `Group`, `GroupLabel`, `Item`, `ItemText`, `ItemIndicator`, scroll-arrow, and `Separator` parts. Existing exported JobCtrl names and visual class lists remain intact; Base-only structural classes and CSS-variable names were changed only where the primitive anatomy requires them.
- `apps/web/src/shared/ui/select.tsx:17`: added a Radix-compatible string Root adapter for controlled/uncontrolled values, one-argument `onValueChange`, and scoped `dir`. It derives and stabilizes `{ value, label }` items from direct `SelectItem` descendants so Base `SelectValue` renders display labels such as `public markdown`, not storage values such as `public_markdown`; callers can also provide Base's explicit `items` prop.
- `apps/web/src/shared/ui/select.tsx:186`: split Content into `Portal > Positioner > Popup > List`, explicitly forwards every exposed positioning prop, preserves the wrapper's `position="popper"` default through `alignItemWithTrigger={false}`, and retains Radix defaults for fixed positioning, start alignment, offsets, viewport collision padding, arrow padding, and viewport-based collision bounds. `avoidCollisions={false}` maps to Base's all-`none` collision policy, `hideWhenDetached` uses `data-anchor-hidden`, and the Popup ref remains the public Content ref.
- `apps/web/src/shared/ui/select.tsx:282`: maps public `SelectLabel` to Base `GroupLabel`, maps Item `textValue` to Base `label`, keeps string item values required, and changes the indicator and trigger icon from Radix `asChild` to Base `render` composition.
- `apps/web/src/shared/ui/select.test.tsx`: adds focused regression coverage for inferred formatted labels, controlled and uncontrolled string values, callback arity, placeholder/disabled states, group labeling, popper positioning, right-to-left logical positioning, and a zero-critical/serious open-state axe check that includes the portaled popup anatomy.
- `apps/web/src/contexts/scoring/components/CompensationSourcePolicyPanel.test.tsx:166`: proves the real consumer shows `public markdown` and that choosing the formatted `partner api` option persists the canonical `partner_api` value through the API port.
- `apps/web/src/shared/ui/select.stories.tsx`: expands stories across populated, open, placeholder, controlled, disabled, right-to-left, and long-scroll states, plus a tagged browser contract that checks label formatting, popup positioning mode, and group-label association.
- `apps/web/src/shared/ui/base-ui-migration-boundary.test.ts`: removes Select from the temporary direct-Radix allowlist. `grep -n "radix-ui\|@radix-ui" apps/web/src/shared/ui/select.tsx apps/web/src/shared/ui/select.test.tsx apps/web/src/shared/ui/select.stories.tsx` returns no matches.

## Left alone

- `apps/web/src/contexts/scoring/components/CompensationSourcePolicyPanel.tsx` keeps its existing Select markup and string callback API because the compatibility adapter preserves both; only its regression test changed.
- Native `<select>` elements in Runs filters, AI model policy controls, and the resume plate editor are unrelated to the shared Radix wrapper and remain untouched.
- Dialog, dropdown-menu, sheet, toast, toggle-group, package metadata, and the direct-Radix dependency removal remain on separately owned migration slices.

## Behavior changes

- Radix `asChild` composition on Trigger, Value, Content, Label, Item, and Separator is replaced by Base UI `render` composition. No in-repository Select consumer uses `asChild`; the wrapper's own trigger icon and item indicator now use `render`.
- Root `onOpenChange` now receives Base UI event details as its second argument. Existing zero- or one-argument handlers remain compatible, and no in-repository Select consumer reads the additional argument.
- Base Portal adds a `<div data-base-ui-portal>` and Positioner DOM layer. Popup/List expose Base `data-open`, `data-closed`, `data-side`, and `data-align` attributes instead of Radix Content's `data-state`; no in-repository Select consumer targets the removed attributes.
- Base ItemText renders a `<div>` rather than Radix's `<span>`. The wrapper keeps the same text and layout contract, and no repository selector depends on the old element name.
- Base scroll arrows do not render for touch input. Pointer, keyboard, typeahead, selected-item, disabled-item, and scroll behavior otherwise remain owned by Base UI.
- Radix Content `onCloseAutoFocus`, `onEscapeKeyDown`, and `onPointerDownOutside` are not accepted by the compatibility Content wrapper. Base exposes final focus on Popup and close interception through Root `onOpenChange` event details; no repository consumer uses the old callbacks.
- Radix `sticky="partial" | "always"` has no exact Base equivalent. The wrapper maps the unused default `partial` to Base `false` and `always` to Base `true`; no repository consumer supplies `sticky`.
- Automatic label inference can inspect direct/nested JSX `SelectItem` elements, including arrays and fragments, but cannot execute an arbitrary custom component that privately returns items. Such abstractions must pass Base's explicit `items` prop. All current repository consumers and stories use inspectable items and are covered.

## Verify by hand

1. Open `Shared/UI/Select/MigrationContract`; confirm the trigger says `Licensed API`, not `licensed_api`, and the popup is open below the trigger with the labeled option group.
2. Open `Shared/UI/Select/Controlled`; choose Regular and Comfortable, then reopen the list and use Arrow Up/Down, Home/End, typeahead, Enter, and Escape.
3. Open `Shared/UI/Select/LongScrollableList`; confirm the top and bottom scroll arrows appear only when their direction can scroll and that hovering them moves the list.
4. Open Settings > Compensation sources; confirm Levels.fyi shows `public markdown`, open Glassdoor access mode, choose `partner api`, and verify the saved status appears without changing the displayed label to the underscore-delimited storage value.

Derived summary: 5 shared UI wrappers currently retain direct Radix imports in the shared worktree (`dialog`, `dropdown-menu`, `sheet`, `toast`, and `toggle-group`).
