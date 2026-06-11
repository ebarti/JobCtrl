---
gsd_state_version: 1.0
milestone: v1.2
milestone_name: Apply Review Audit UX - Drawer + Resume Pins
status: planning
last_updated: "2026-06-11T20:10:00.000Z"
last_activity: 2026-06-11
progress:
  total_phases: 5
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-11)

**Core value:** A user can trust every line of a tailored resume because each bullet traces visibly to a real profile fact and a specific job requirement, with the reasoning and transform rule available for review.
**Current focus:** Milestone v1.2 planning complete enough to start Phase 12.

## Current Position

Phase: 12 - Folded Cleanup + Verification Baseline
Plan: Not created
Status: Ready to plan Phase 12
Last activity: 2026-06-11 - v1.2 research, requirements, and roadmap initialized

## Active Milestone Summary

Milestone v1.2 implements Sketch 002 Option 1: Drawer + Resume Pins. The milestone updates two existing surfaces:

| Surface | Owns |
|---------|------|
| Jobs row-click drawer (`JobDetailDrawer`) | Why ranked, readiness, hard blockers, eligibility concerns, and handoff to Apply Review |
| Apply Review rendered resume/material surface | Source-to-artifact changes, grounding, claim risk, readiness agreement, and reviewer inspection before approval |

Cross-surface invariant: readiness and eligibility/blocker facts must come from one shared API/read contract so the product cannot show contradictory facts for the same job.

The leftover v1.1 cleanup is folded into v1.2 as a small early housekeeping slice. It covers stale verification command normalization, dependency/config audits, optional obsolete `lucide-react` cleanup only if import proof allows it, and narrow docs/config updates for final shadcn token, Tabler icon, font, and QA expectations.

Explicitly not in scope:

- Option 2 Evidence Ledger and Option 3 Gate Timeline.
- Blind-auto-apply safety positioning in UI; README/docs positioning stays deferred.
- Auto-apply, browser submission, mailbox scanning, real generated-material regeneration, destructive profile/database actions, or worker-backed jobs unless explicitly requested later.
- Broad route redesign, scoring/tailoring policy redesign, worker automation expansion, marketing dashboard treatment, or landing-page work.
- Hiding/suppressing missing audit data as a substitute for fixing the source of truth.

## Roadmap

| Phase | Name | Status | Requirements |
|-------|------|--------|--------------|
| 12 | Folded Cleanup + Verification Baseline | Planned | CLEAN-01..CLEAN-04 |
| 13 | Shared Apply Audit Contract | Planned | AUDIT-01..AUDIT-06 |
| 14 | Jobs Drawer Audit Triage | Planned | DRAWER-01..DRAWER-06 |
| 15 | Apply Review Resume Pins | Planned | REVIEW-01..REVIEW-08 |
| 16 | Product-Path QA + Documentation | Planned | QA-01..QA-06 |

Next command: `$gsd-plan-phase 12`.

## Research Summary

Research completed on 2026-06-11 in `.planning/research/`.

Key findings:

- Use the existing React/Vite/Tailwind/TanStack/shadcn stack; no new runtime dependency is recommended for the MVP.
- A shared apply audit contract must precede UI work.
- Resume pins should be derived from canonical artifact audit data, starting with `bulletProvenance` and `annotatedChanges`.
- Jobs drawer and Apply Review have separate responsibilities; ranking belongs in Jobs, generated-material proof belongs in Apply Review.
- QA must use synthetic/seeded data and must not trigger apply submission or worker-backed automation.

## Prior Milestone Verification

Milestone v1.0 was verified on 2026-06-09. All five phases plus cross-phase integration returned PASS. The durable summary is `.planning/MILESTONE-ACCEPTANCE.md`.

Milestone v1.1 completed Phases 6-10 and landed semantic tokens, shared primitives, layout chrome, Tabler target, status semantics, and route visual QA via PRs #151-#155. The planned Phase 11 cleanup did not start and is now folded into v1.2 Phase 12.

## Accumulated Context

### Current Decisions

- Choose Sketch 002 Option 1: Drawer + Resume Pins for implementation.
- Define "job overlay" as the Jobs row-click drawer (`JobDetailDrawer`), not an Apply Review queue panel.
- Keep Apply Review centered on the rendered resume/material, with row/claim pins for evidence inspection.
- Share readiness and eligibility facts across Jobs drawer and Apply Review from one contract/source of truth.
- Fold the leftover v1.1 cleanup into v1.2 as housekeeping, not as the core product outcome.
- Defer blind-auto-apply safety positioning to README/docs rather than the v1.2 UI scope.

### Constraints And Concerns

- Auditability risk: the UI must not hide missing or embarrassing audit data; missing sources must be fixed at the owning layer.
- Scope risk: ranking explanation belongs in the Jobs row-click drawer, while generated-material proof belongs in Apply Review.
- Pin risk: PDF coordinates may be brittle; start from generated text/provenance anchors and validate visual placement during Phase 15.
- QA risk: browser proof must use synthetic/seeded data and must not run auto-apply, browser submission, mailbox scanning, real material generation, destructive profile/database actions, or worker-backed jobs.
- Cleanup risk: folded v1.1 cleanup should close stale dependency/config/docs items without re-opening broad visual-system migration.

## Deferred Items

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Audit UX | Option 2 Evidence Ledger | Future milestone | 2026-06-11 |
| Audit UX | Option 3 Gate Timeline | Future milestone | 2026-06-11 |
| Audit UX | Deep PDF coordinate annotation beyond stable provenance/text anchors | Future milestone unless Phase 15 proves required | 2026-06-11 |
| Product positioning | README/docs copy explaining why JobHunter is safer than blind auto-apply tools | Future docs update | 2026-06-11 |
| Visual system | User-editable theme customization | Future milestone | 2026-06-09 |
| Visual system | Dedicated visual regression service such as Chromatic/Loki/Percy | Future milestone | 2026-06-09 |
| Motion | Motion and microinteraction system | Future milestone | 2026-06-09 |

## Session Continuity

Last session: 2026-06-11
Stopped at: v1.2 milestone initialized through roadmap
Resume file: None
