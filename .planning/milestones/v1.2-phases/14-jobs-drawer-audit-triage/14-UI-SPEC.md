---
phase: 14-jobs-drawer-audit-triage
status: approved
checked_at: 2026-06-11
---

# Phase 14 UI Spec

## Surface

Existing Jobs row-click drawer (`JobDetailDrawer`).

## Layout Contract

- Place an audit triage section directly below `JobOverview`.
- Use a compact two-column grid on wide drawer widths:
  - Ranking explanation.
  - Readiness / blockers.
- Collapse to one column under existing mobile drawer width.
- Keep the full existing `Score breakdown` section lower in the drawer.

## Content Contract

Ranking panel:
- Fit score and score band/confidence.
- Score reasoning when recorded.
- Matched, missing, transferable signals.
- Keywords.
- Policy/scoring metadata when recorded.

Readiness panel:
- `applyAudit.label` and `applyAudit.summary`.
- Missing prerequisites.
- Hard blockers.
- Eligibility concerns.
- Missing/unknown essential sources when present.

Handoff:
- Provide an in-drawer link to `/apply-review`.
- Handoff copy must be short and operational, not marketing copy.

## Visual Contract

- Use existing `.section`, `.tag`, `.fit`, `.muted`, and color tokens.
- Tags wrap and never resize the drawer.
- Cards are not nested inside cards; this is a normal drawer section with internal rows.
- No new icons unless an existing Tabler icon materially clarifies a button/link.

## Accessibility Contract

- Use semantic headings and lists/definition lists.
- Status is not color-only; label and summary are text.
- Handoff link has a clear accessible name.

## Out Of Scope

- Resume/material pinning.
- PDF coordinates.
- Apply decision controls inside Jobs drawer.
- Any apply/browser automation.

