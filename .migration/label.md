# label

2026-07-14 — golden pair via CLI, migrated the wrapper to a native semantic label while preserving the public `Label` export and CVA styling.

## Changed

- `apps/web/src/shared/ui/label.tsx`: replaced `@radix-ui/react-label` with a native `<label>` while retaining the existing CVA class list, prop forwarding, and ref support.
- `apps/web/src/shared/ui/label.test.tsx`: added coverage for native label semantics, control association, and retained styling classes.
- `apps/web/src/shared/ui/base-ui-migration-boundary.test.ts`: removed the migrated Label wrapper from the temporary direct-Radix allowlist.
- `grep -n "radix-ui\\|@radix-ui" apps/web/src/shared/ui/label.tsx` returns no matches.

## Left alone

- `apps/web/src/shared/ui/label.stories.tsx`: its existing stories still exercise the exported `Label` and its input association; no story change was required.
- Other shared UI wrappers remain on their assigned migration paths and were not changed.

## Behavior changes

- A native label does not retain Radix's double-click text-selection prevention. The existing wrapper had no `select-none` class, so that behavior is deliberately not recreated.

## Verify by hand

1. Open the Label Storybook story and confirm its typography matches the current form labels.
2. In the WithInput story, click the label and verify focus moves to the numeric input.
