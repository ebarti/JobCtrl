# toast

2026-07-15 — transformation-engine migration from Radix Toast to Base UI 1.6; the registry does not provide a toast golden pair.

## Changed

- `apps/web/src/shared/ui/toast.tsx`: replaced Radix primitives with Base UI's manager, provider, portal, viewport, root, content, action, close, title, and description parts while retaining the shared exports and visual classes.
- `apps/web/src/shared/ui/toaster.tsx`: bridges the existing Zustand toast queue to one stable Base UI manager and renders manager-owned toast objects.
- `apps/web/src/shared/ui/toast.stories.tsx` and `toast.a11y.test.tsx`: seed manager-owned fixtures instead of the removed declarative Radix API.
- `apps/web/src/shared/ui/base-ui-migration-boundary.test.ts`: removed Toast from the direct-Radix allowlist.

## Left alone

- Production callers keep using `useToastStore`; no caller API or toast payload changed.
- Visual redesign is intentionally deferred.

## Behavior changes

- Base UI uses `F6` for viewport focus; `{hotkey}` labels now resolve to `F6` instead of Radix's default `F8`.
- Base UI renders title and description as `h2` and `p`; Radix rendered `div` elements.
- Base UI manager ownership replaces Radix's declarative `open` contract. Unlimited queueing, high-priority announcements, right-swipe dismissal, timeouts, variants, and close-to-store synchronization are preserved.

## Validation

- Deferred at the user's request until the full migration and redesign stack is complete.
