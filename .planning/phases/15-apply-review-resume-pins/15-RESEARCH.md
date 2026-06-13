---
phase: 15-apply-review-resume-pins
status: complete
created: 2026-06-11
---

# Phase 15 Research

## Existing Surfaces

- `apps/web/src/views/apply-review/ApplyReviewView.tsx` owns the Apply Review layout, queue, selected item header, status note, job evidence pane, and materials pane.
- `ResumePreview` already renders the PDF preview or text fallback.
- `ArtifactTailoringInspector` fetches artifact detail through `useArtifactDetailQuery` and renders `TailoringExplanationSection`.
- `TailoringExplanationSection` already displays annotated changes, per-bullet provenance, keyword coverage, quality, judge, adversarial review, review feedback, and generation context.

## Canonical Data

- `ArtifactTailoringExplanation.bulletProvenance` is the canonical per-bullet evidence x requirement x transform x control x rationale record.
- `ArtifactTailoringExplanation.annotatedChanges` carries source text and tailored text used for source-to-generated comparison.
- Quality, judge, adversarial review, and review feedback fields provide artifact-level grounding and risk signals.
- Apply readiness remains sourced from the shared `ApplyAudit` contract created in Phase 13.

## Web Guidance

`modern-web-guidance` returned CSS layout and size-aware styling guidance. Phase 15 should use grid/flex, intrinsic sizing, stable scroll containers, and container-aware responsive behavior without viewport-scaled typography or new dependencies.

## Implementation Shape

- Add a context-owned material component that fetches artifact detail and renders resume claim pins.
- Compose that component from `ApplyReviewView` next to the rendered resume preview.
- Keep the full inspector below the resume-centered pin surface to preserve existing audit depth.

