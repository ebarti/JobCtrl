---
phase: 14-jobs-drawer-audit-triage
plan: 14-01
status: complete
completed: 2026-06-11
---

# 14-01 Summary: Drawer Audit Triage Component

## Implemented

- Added `JobAuditTriage` to the Jobs view drawer surface.
- Mounted the triage section immediately after `JobOverview` in `JobDetailDrawer`.
- Rendered ranking facts from existing score read-model fields:
  - fit score
  - fit band
  - confidence
  - eligibility status
  - score rationale
  - matched, missing, transferable, and keyword signals
  - scoring criteria and trace metadata where present
- Rendered readiness, missing prerequisites, hard blockers, eligibility concerns, and source facts only from the shared `detail.applyAudit` contract added in Phase 13.
- Added a non-mutating handoff link to `/apply-review` for generated-material inspection.
- Added scoped responsive drawer CSS for dense metrics, fact groups, wrapping tags, and mobile collapse.

## Invariants Preserved

- The component does not derive readiness from local material/stage fields.
- The handoff link does not start apply automation or material generation.
- Existing drawer sections remain mounted after the new triage section: job actions, preparation diagnostics, artifacts, employer analysis, tailoring inspector, apply history, outcomes, score breakdown, description, and audit history.

## Files

- `apps/web/src/views/jobs/JobAuditTriage.tsx`
- `apps/web/src/views/jobs/JobDetailDrawer.tsx`
- `apps/web/src/styles/globals.css`

