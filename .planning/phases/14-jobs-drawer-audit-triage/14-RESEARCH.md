---
phase: 14-jobs-drawer-audit-triage
status: completed
researched_at: 2026-06-11
---

# Phase 14 Research

## Current Drawer Shape

- `JobDetailDrawer` renders `JobOverview`, actions, preparation diagnostics, artifacts, employer analysis, tailoring inspector, apply history, outcomes, score breakdown, description, and audit history in sequence.
- `JobOverview` currently shows the fit badge, company/provenance, title, location/salary, and original-posting link.
- Ranking evidence exists but is pushed down into the generic Score Breakdown section.
- Readiness and blocker facts are now available as `detail.applyAudit` from Phase 13.

## User Story Mapping

- "Why ranked" maps to fit score, band, confidence, reasoning, matched/missing/transferable signals, keywords, and policy metadata where available.
- "Ready for apply review" maps to `detail.applyAudit.state`, label, summary, and source status.
- "Hard blockers / eligibility concerns" maps to `detail.applyAudit.hardBlockers`, `detail.applyAudit.missingPrerequisites`, and `detail.applyAudit.eligibilityConcerns`.
- "Handoff to Apply Review" maps to a clear route link/action to `/apply-review`, not duplicated resume proof inside the Jobs drawer.

## Frontend Guidance

Modern web guidance for dense React detail drawers points to normal CSS grid/flex layout and size-aware styling. Phase 14 should not introduce a new drawer primitive. Use stable grid tracks, wrapped tags, and existing semantic colors.

## Risks

- **Duplication risk:** Copying the full score breakdown or material inspector into the top panel would make the drawer long and redundant.
- **Contract drift:** Readiness display must use `applyAudit`, not local stage/material logic.
- **Workflow regression:** Existing drawer actions and lower sections must remain present and accessible.
- **Visual crowding:** Ranking, readiness, and blockers must be scannable without making a marketing-style hero.

## Recommended Implementation

- Add a new `JobAuditTriage` component colocated with Jobs view components.
- Render `JobAuditTriage` near the top of `JobDetailDrawer`, immediately after `JobOverview`.
- Reuse local formatting helpers for score facts and audit facts.
- Add CSS scoped to `.job-audit-triage`.
- Add tests for rank evidence, readiness/blockers from `applyAudit`, handoff link, and preservation of existing sections.

