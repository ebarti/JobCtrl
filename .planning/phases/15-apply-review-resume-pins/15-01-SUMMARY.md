---
phase: 15-apply-review-resume-pins
plan: 15-01
status: complete
completed: 2026-06-11
---

# 15-01 Summary: Resume Pin Component And Layout

## Implemented

- Added `ResumeAuditPins` as a context-owned materials component.
- Fetches artifact detail through `useArtifactDetailQuery`.
- Derives selectable pins from canonical `bulletProvenance`, with `annotatedChanges` fallback when no bullet rows exist.
- Pin detail shows source text, tailored text, transform, controls, evidence IDs, requirement IDs, matched keywords/signals, rationale, and grounding/risk facts.
- Apply Review now places the rendered resume first in a `Rendered resume audit` region, with claim pins beside it on wider containers and below it on narrow containers.
- The full `ArtifactTailoringInspector` remains below the resume-centered pin surface.
- Missing artifact IDs, missing explanations, missing pin rows, and missing source text render explicit empty states.

## Files

- `apps/web/src/contexts/materials/components/ResumeAuditPins.tsx`
- `apps/web/src/views/apply-review/ApplyReviewView.tsx`
- `apps/web/src/styles/globals.css`

