---
phase: 09-domain-and-status-surface-migration
plan: 09-02
status: completed
completed: 2026-06-10
---

# 09-02 Summary: Domain Status Surfaces

## Completed Work

- Mapped apply run, workflow run, application outcome, dashboard source health, debug activity, and job audit tones through typed helpers or explicit maps.
- Preserved status text and audit detail rendering while moving visual tone selection away from ad hoc class strings.
- Retokenized global status CSS for `tag`, `status-dot`, `fit`, `stage-pill`, `banner`, finding lists, and segment bars with standard semantic tokens and local color-mix derivations.
- Added explicit tests for apply timeline level tones, run badges, artifact status badges, score badges, debug activity tones, and job audit tone rendering.

## Verification

- `corepack pnpm --filter @jobhunter/web test` - PASS, 135 files / 724 tests.
- `corepack pnpm web:check` - PASS.
- `JOBHUNTER_E2E_API_PORT=8877 JOBHUNTER_E2E_WEB_PORT=5274 corepack pnpm --filter @jobhunter/web e2e -- tests/token-foundation.spec.ts` - PASS after macOS sandbox escalation, 4 Chromium tests.
- In-app browser smoke on disposable E2E data confirmed painted status selectors on Dashboard, Jobs, Apply Review, Artifacts, Runs, and Debug after route data loaded.

## Notes

- The E2E status smoke asserts painted semantic classes that are actually present in the seeded data. Full tone-arm coverage remains in unit/parity tests where fixtures can cover every discriminant without relying on route seed shape.
