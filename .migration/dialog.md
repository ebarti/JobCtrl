# dialog

2026-07-15 — migrated the shared Dialog wrapper from Radix to Base UI 1.6 using the current radix-luma/base-luma registry pair as the structural reference.

## Changed

- Replaced Radix Dialog parts with Base Dialog parts while retaining exported names, modal behavior, visual classes, and controlled/uncontrolled state.
- Kept a narrow `asChild` adapter for existing Trigger/Close consumers, mapped `forceMount` to Portal `keepMounted`, and added the missing accessible title to `CommandDialog`.
- Removed Dialog from the direct-Radix boundary allowlist and added focused unit/a11y coverage. Execution is deferred until cumulative QA.

## Left alone

- Existing native-button and shared-Button consumers remain on the safe adapter. Package metadata, public docs, and cumulative QA are deferred.

## Behavior changes

- Base Portal adds its wrapper and uses `data-open`/`data-closed`. Root callbacks may receive Base event details. Unused Radix Content dismissal/autofocus callbacks are not retained.

## Verify by hand

1. Verify dialog labels, modal focus/scroll behavior, dismissal paths, and trigger focus return.
