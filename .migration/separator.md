# separator

2026-07-14 — golden pair via CLI, migrated the wrapper to the Base UI separator while preserving the public `Separator` export, orientation, and rule styling.

## Changed

- `apps/web/src/shared/ui/separator.tsx`: replaced `@radix-ui/react-separator` with `@base-ui/react/separator`, preserving orientation classes and ref support.
- `apps/web/src/shared/ui/separator.test.tsx`: added semantic-role and horizontal/vertical orientation coverage.
- `apps/web/src/shared/ui/base-ui-migration-boundary.test.ts`: removed the migrated Separator wrapper from the temporary direct-Radix allowlist.
- `grep -n "radix-ui\\|@radix-ui" apps/web/src/shared/ui/separator.tsx` returns no matches.

## Left alone

- `apps/web/src/shared/ui/separator.stories.tsx`: the existing horizontal and vertical stories remain valid against the unchanged public API.
- Other shared UI wrappers remain on their assigned migration paths and were not changed.

## Behavior changes

- The Radix-only `decorative` prop is removed. Base UI separators are always semantic (`role="separator"`), while their visuals and orientation remain unchanged.

## Verify by hand

1. Open the Separator Storybook stories and confirm horizontal rules retain their full-width, one-pixel appearance.
2. Confirm vertical separators in the Vertical and DenseToolbar stories retain their full-height, one-pixel appearance and appear between adjacent text.
