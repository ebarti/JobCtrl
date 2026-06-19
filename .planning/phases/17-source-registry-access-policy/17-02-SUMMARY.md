---
phase: 17-source-registry-access-policy
plan: 17-02
status: complete
completed: 2026-06-19
---

# 17-02 Summary: Settings Source Policy UI

## Completed

- Added `compensationSources()` to the web API port and local adapter.
- Added an Operations-owned compensation source query key and read hook.
- Added a Scoring-owned `CompensationSourcePolicyPanel`.
- Composed the panel into the Settings index route below the existing config panel.
- Added MSW fixtures, hook tests, panel tests, no-nested-card regression coverage, and axe coverage.
- Documented the read-only endpoint in `docs/local-ts-api.md`.

## Result

Users can inspect compensation source availability and licensing policy from Settings. Europe public baselines are distinct from unavailable licensed seams, and the panel does not expose action controls for Levels.fyi or Glassdoor.
