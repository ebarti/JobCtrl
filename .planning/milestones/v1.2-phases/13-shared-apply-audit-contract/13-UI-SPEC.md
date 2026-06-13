---
phase: 13-shared-apply-audit-contract
status: approved
checked_at: 2026-06-11
---

# Phase 13 UI Spec

## Purpose

Apply Review must stop deciding readiness locally. The visible status tag, queue counts, selected header, and blocker explanation should reflect `applyAudit` from the API.

## Surfaces

- Apply Review queue item status tag.
- Apply Review selected application header status tag.
- Apply Review top status note.
- Apply Review queue summary counts.
- Optional compact status details below the summary note.

The Jobs drawer must receive the same contract in Phase 13, but the visible drawer redesign is Phase 14.

## Copy Contract

- Use `applyAudit.label` for short tags.
- Use `applyAudit.summary` for the first sentence in the selected status note.
- Show missing prerequisites, hard blockers, and eligibility concerns as short fact rows when present.
- Use source labels/statuses only as supporting proof; do not invent readiness from display helpers.

## Visual Contract

- Reuse existing `tag`, `meta`, and status-note styling.
- Add only small scoped CSS under Apply Review if the fact list needs spacing.
- Keep tone mapping deterministic:
  - `ready` -> `ok`
  - `preparing` -> `info`
  - `blocked` -> `warn`
  - `repair` -> `warn`
- Queue counts group `blocked` and `repair` under "need repair" for the existing header until Phase 14 introduces richer language.

## Interaction Contract

- No new navigation, modals, tabs, or controls in Phase 13.
- The "open job detail" button remains an in-place overlay opener.
- Apply approval controls remain unchanged and must not dispatch apply automation.

## Accessibility Contract

- Status details must be text, not color-only.
- Fact rows must remain visible to screen readers as ordinary list content.
- Existing button labels and dialog behavior remain unchanged.

## Out Of Scope

- Jobs drawer visual triage layout.
- Resume pins or claim-level proof.
- PDF coordinate annotation.
- New documentation copy about blind auto-apply safety.

