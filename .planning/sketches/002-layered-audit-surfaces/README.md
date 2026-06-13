---
sketch: 002
name: layered-audit-surfaces
question: "How should audit responsibilities split between the job overlay and the rendered resume review surface while reusing readiness and eligibility?"
winner: null
tags: [job-overlay, apply-review, readiness, eligibility, provenance]
---

# Sketch 002: Layered Audit Surfaces

## Design Question

Can JobHunter explain the right facts in the right layer without creating one overloaded mega-review page?

## How to View

Open `.planning/sketches/002-layered-audit-surfaces/index.html`.

The page is a launcher. Each option is a real link that opens in a new browser tab/window:

- `?option=1` - Drawer + Resume Pins
- `?option=2` - Evidence Ledger
- `?option=3` - Gate Timeline

## User Story Split

### Job Overlay: Jobs Row-Click Popup

- why this job was ranked the way it was
- whether the job is ready for apply review
- what hard blockers or eligibility concerns exist

In product terms, this means the existing Jobs view popup/drawer opened by clicking a job row (`JobDetailDrawer`), not an apply-review queue panel.

### Apply Review Resume Surface

- what hard blockers or eligibility concerns exist
- whether the job is ready for apply review
- what changed from source profile/resume to tailored artifact
- whether generated claims are grounded or risky

### Deferred

- why JobHunter is safer than blind auto-apply tools

This belongs in README/docs positioning later, not in this UI sketch.

## Options

- Option 1: Drawer + Resume Pins - lowest-migration design that keeps the existing Jobs popup and adds row-level proof on the rendered resume.
- Option 2: Evidence Ledger - dense audit design where ranking, blockers, material changes, grounding, and risk are expressed as inspectable rows.
- Option 3: Gate Timeline - guided decision design that explains readiness as a sequence from rank to eligibility to generated-material review.
