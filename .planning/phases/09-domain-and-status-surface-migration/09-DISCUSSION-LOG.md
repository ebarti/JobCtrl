---
phase: 09-domain-and-status-surface-migration
created: 2026-06-10T12:51:53Z
mode: autonomous-defaults
---

# Phase 09 Discussion Log

## Question: Which status surfaces are in scope?

Defaulted to the roadmap boundary: pipeline/stage states, scoring, artifacts/materials audit, apply/workflow status, discovery/source health, dashboard funnel/KPI state, debug/audit timeline state, missing/stale/blocked/failed/running states.

## Question: Should this phase redesign visual status colors?

No. The goal is semantic preservation through shadcn standard tokens, not a redesign. Use the existing standard token palette and typed maps.

## Question: Should route-wide browser QA happen here?

Only a targeted status smoke is required here. Full route visual QA across all representative routes and density/theme combinations belongs to Phase 10.

## Question: Should `lucide-react` be removed?

No. Phase 9 can reduce remaining domain imports. Package dependency removal is Phase 11 after import audits prove zero use.

## Question: What is the auditability invariant?

Every displayed claim must remain traceable to its source of truth. Visual cleanup must not hide missing provenance, stale score status, failed workflow state, residual warnings, or generated-material audit details.

