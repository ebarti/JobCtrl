---
phase: 15-apply-review-resume-pins
status: complete
created: 2026-06-11
---

# Phase 15 UI Spec

## Layout

- Application Materials pane starts with a `Rendered resume audit` region.
- The rendered resume preview is the first and largest object in that region.
- Resume claim pins sit beside the preview on wider containers and stack below it on narrow containers.
- The full tailoring rationale follows the resume-centered pin surface.

## Pin Behavior

- Pins are buttons with stable accessible names.
- One pin is selected by default when pins exist.
- Selecting a pin updates the detail panel without navigating or mutating data.
- Keyboard users can tab through pins and read detail in DOM order.

## Pin Detail

Each selected pin shows:

- source profile/resume text or explicit source-missing state
- generated tailored artifact text or explicit generated-text-missing state
- transform/change type
- governing control(s)
- requirement IDs
- evidence IDs
- matched keywords or job signals
- rationale
- grounding/risk status from artifact audit signals
- lifecycle labels for repair attempted and residual warnings where recorded

## Empty States

- No artifact ID: no resume artifact is available to inspect.
- Loading/error: artifact detail status is explicit.
- No tailoring explanation: no provenance was recorded for the artifact.
- No pin rows: no resume claim pins were recorded for this artifact generation.

