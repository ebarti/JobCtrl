---
phase: 14-jobs-drawer-audit-triage
status: ready_for_planning
gathered_at: 2026-06-11
---

# Phase 14: Jobs Drawer Audit Triage - Context

<domain>
## Phase Boundary

Phase 14 updates the existing Jobs row-click drawer (`JobDetailDrawer`) so the first screen explains why a job ranked the way it did, whether it is ready for apply review, and which blockers or eligibility concerns exist.

This phase does not build Apply Review resume pins, does not duplicate the full generated-material audit surface, and does not change apply submission behavior.
</domain>

<decisions>
## Implementation Decisions

- Add a top-of-drawer audit triage surface immediately after the title/provenance header.
- Use `detail.applyAudit` from Phase 13 as the only readiness/blocker source.
- Use existing score data (`fitScore`, `scoreBreakdown`, `scoreKeywords`, `scoreReasoning`, `scoreTrace`, `scoreCriteria`) for ranking explanation.
- Keep the existing Score Breakdown section lower in the drawer for full detail; the new top panel is a scannable summary.
- Separate job-fit/ranking evidence from material proof. The Jobs drawer can name readiness and blockers, but Apply Review remains the generated-material inspection surface.
- Preserve existing drawer workflows: close/backdrop/escape, JobActions, retry affordances, artifacts, material inspector, apply history, outcome panel, score correction, description, and audit history.
</decisions>

<ui_constraints>
## UI Constraints

- Keep the drawer dense and work-focused.
- Use existing tags, fit badges, section styling, and status colors.
- No new package dependency.
- No nested cards.
- No marketing copy or explanatory feature text.
- Avoid layout shifts by using fixed summary grid tracks and wrapped tags.
</ui_constraints>

<code_context>
## Existing Code Insights

- `apps/web/src/views/jobs/JobDetailDrawer.tsx` composes the drawer.
- `apps/web/src/views/jobs/JobOverview.tsx` renders the current header.
- `apps/web/src/contexts/scoring/components/ScoreBreakdown.tsx` already renders full scoring detail and can remain as the lower detailed section.
- `apps/web/src/test/fixtures/projections.ts` now provides `makeApplyAudit` and `makeJobDetail`.
- `apps/web/src/views/jobs/JobDetailDrawer.test.tsx` and `JobOverview.test.tsx` cover current drawer behavior.
</code_context>

<deferred>
## Deferred

- Apply Review resume pins and claim-level proof are Phase 15.
- README/docs copy about safer-than-blind-auto-apply positioning remains deferred.
</deferred>

