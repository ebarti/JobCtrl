# tabs

2026-07-14 — engine, migrated the Tabs wrapper from Radix to Base UI while retaining the existing string-value API, automatic keyboard activation, and mounted-panel compatibility.

## Changed

- `apps/web/src/shared/ui/tabs.tsx`: replaced Radix Root/List/Trigger/Content with Base UI Root/List/Tab/Panel, translated active and disabled selectors, and retained the exported wrapper names.
- The wrapper maps Radix `activationMode` to Base UI `activateOnFocus`, Radix List `loop` to `loopFocus`, Radix Content `forceMount` to `keepMounted`, and Radix `dir` to a scoped Base UI `DirectionProvider` while retaining the root DOM attribute; explicit Base UI props take precedence. Direct testing confirmed that Base UI 1.6 reads its direction context for composite keyboard navigation, so the DOM attribute alone does not reverse the arrow-key order.
- `apps/web/src/shared/ui/tabs.stories.tsx`: added manual-activation and right-to-left stories for keyboard review.
- `apps/web/src/shared/ui/tabs.test.tsx`: covers uncontrolled and controlled state, automatic and manual keyboard activation, right-to-left navigation, explicit List overrides, disabled tabs, and forced mounting.
- `apps/web/src/shared/ui/base-ui-migration-boundary.test.ts`: removed Tabs from the temporary direct-Radix allowlist.
- `grep -n "radix-ui\|@radix-ui" apps/web/src/shared/ui/tabs.tsx` returns no matches.

## Left alone

- `apps/web/src/contexts/discovery/components/DiscoveryProductControls.tsx` keeps its existing Tabs API because the wrapper preserves automatic activation.
- `apps/web/src/contexts/pipeline/components/StageTriggerPanel.tsx` keeps `forceMount`; the compatibility wrapper maps it to Base UI `keepMounted`.
- `apps/web/components.json`, package metadata, lockfiles, global CSS, and other shared UI wrappers remain on their separately owned migration paths.

## Behavior changes

- There is no activation-mode delta: arrow-key focus activates tabs by default, while `activationMode="manual"` and an explicit List `activateOnFocus={false}` retain manual activation.
- Radix `asChild` composition on Root, List, Trigger, and Content is no longer accepted; Base UI uses `render` composition instead. No in-repository Tabs consumer uses `asChild`.
- Explicit unmatched uncontrolled defaults retain Base UI's fallback behavior rather than Radix's: `<Tabs defaultValue="missing">` selects the first enabled Base tab and mounts its panel, while Radix leaves every tab unselected and mounts no panel. Base UI 1.6 initially honors an explicitly disabled default; after an uncontrolled selection has been valid, later disabling or removing that selected tab falls back to the first enabled tab, or to no selection when none remain. Controlled `value` roots keep the exact supplied value and do not apply these fallbacks. The wrapper intentionally does not recreate Radix's missing-selection behavior.
- Radix Tabs 1.1.13 excludes disabled triggers from its roving-focus sequence (`focusable={!disabled}`), while Base UI 1.6 intentionally keeps disabled composite tabs focusable so their disabled state can be discovered. Base UI exposes no supported option to change that navigation policy without replacing its Tabs composite implementation. Disabled tabs expose `aria-disabled` plus `data-disabled`, accept focus, remain non-interactive, and do not activate their panel.
- Inactive forced panels remain mounted with `hidden`, `data-hidden`, and `inert`, matching the existing StageTriggerPanel requirement without changing that consumer.

## Verify by hand

1. Open `Shared/UI/Tabs/StateTabs`, use Left/Right arrows, and confirm a disabled tab can receive focus but does not activate; the next arrow press continues to an enabled tab and activates it.
2. Open `Shared/UI/Tabs/ManualActivation`, use Left/Right arrows, and confirm focus moves without changing panels until Enter or Space is pressed.
3. Open `Shared/UI/Tabs/RightToLeft`, focus First, press Arrow Left, and confirm focus and selection move to Second rather than wrapping to Third.
4. Open Pipeline actions, switch between Discover and Apply, and confirm both tabpanels remain in the DOM while only the active stage form is visible.

Derived summary: 8 shared UI wrappers remain on Radix.
