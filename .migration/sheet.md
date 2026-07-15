# sheet

2026-07-15 — migrated the shared Sheet wrapper from Radix Dialog to Base UI Dialog 1.6 using the current radix-luma/base-luma registry pair as the structural reference.

## Changed

- Replaced Radix Dialog parts with Base Dialog parts while retaining exported Sheet names, modal behavior, all four side layouts, and existing visual tokens.
- Kept a narrow `asChild` adapter for existing Trigger/Close consumers, mapped `forceMount` to Portal `keepMounted`, and translated slide/fade states to Base starting/ending styles.
- Removed Sheet from the direct-Radix boundary allowlist and added focused unit/a11y coverage. Execution is deferred until cumulative QA.

## Left alone

- Existing native-button and shared-Button consumers remain on the safe adapter. Package metadata, public docs, and cumulative QA are deferred.

## Behavior changes

- Base Portal adds its wrapper and uses `data-open`/`data-closed`; Sheet Popup also exposes `data-side`. Root callbacks may receive Base event details. Unused Radix Content dismissal/autofocus callbacks are not retained.

## Verify by hand

1. Verify every side direction, modal focus/scroll behavior, dismissal paths, and trigger focus return.
