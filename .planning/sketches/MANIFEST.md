# Sketch Manifest

## Design Direction

Apply review should feel like an audit console for a technical job seeker: dense, inspectable, calm, and evidence-first. The user should be able to open a job or generated material and immediately understand ranking, eligibility, grounding, generated-material changes, readiness, and why JobHunter is safer than blind auto-apply tools.

After the first sketch pass, the design direction split into layers: the job overlay owns score/ranking explanation plus shared readiness and eligibility; the apply-review resume surface owns rendered material changes, source-to-artifact provenance, grounding, risk, plus the same shared readiness and eligibility. The "safer than blind auto-apply" positioning is deferred to README/docs updates rather than primary UI surface area. Sketch 002 now compares three actual options: Drawer + Resume Pins, Evidence Ledger, and Gate Timeline.

## Reference Points

- Existing JobHunter `/apply-review` queue and artifact inspector.
- Local-first audit surfaces: explicit source facts, generated output, validators, and review gates.
- Modern responsive grid layouts with anchored evidence overlays.

## Sketches

| # | Name | Design Question | Winner | Tags |
|---|------|----------------|--------|------|
| 001 | apply-review-audit-workspace | Which audit workspace structure best explains ranking, blockers, evidence, grounding, material changes, readiness, and safety before a GSD implementation milestone? | null | apply-review, materials, audit, evidence, safety |
| 002 | layered-audit-surfaces | How should audit responsibilities split between the job overlay and the rendered resume review surface while reusing readiness and eligibility? | null | job-overlay, apply-review, readiness, eligibility, provenance |
