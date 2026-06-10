---
phase: 09-domain-and-status-surface-migration
status: completed
completed: 2026-06-10
---

# 09 Status Audit

## Typed Status Sources

- Shared status vocabularies live in `apps/web/src/shared/ui/status-tokens.ts`.
- Domain meaning is mapped through context/view helpers:
  - apply run tones and timeline levels
  - artifact status tones
  - pipeline stage/state tones
  - scoring fit tiers
  - debug activity levels
  - job audit history tones
  - dashboard source/apply/outcome dot states

## Static Audit Results

- Legacy token names in domain/status source scan: PASS, zero matches.
- Lifecycle/status use of `chart-*` in contexts/views/shared: PASS, zero matches.
- Source-level lucide imports: PASS, zero matches in `apps/web/src`; package dependency intentionally deferred to Phase 11.

## Browser Status Proof

The targeted E2E and in-app browser smoke verified painted status selectors on:

- Dashboard: funnel segments, completed apply-run dot, dry-run info tag.
- Jobs: fit scores, apply stage pill, failed/blocked/pending state tags.
- Apply Review: fit score tag and preparing status tag.
- Artifacts: approved status and artifact type tags.
- Runs: active and succeeded workflow status tags.
- Debug: activity level tags.

## Deferred To Phase 10/11

- Phase 10 owns broader route visual QA, overlays, all representative routes, density coverage, and Storybook/a11y hardening.
- Phase 11 owns final dependency removal and global CSS cleanup after full QA proof.
