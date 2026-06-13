# Feature Research

**Domain:** Local-first job-application audit UX
**Researched:** 2026-06-11
**Confidence:** HIGH for milestone scope, MEDIUM for exact pin-anchor affordance until implementation spike

## Feature Landscape

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Job ranking explanation in the Jobs drawer | A technical job seeker needs to know why a job is ranked before investing review time. | MEDIUM | Use existing `ScoreBreakdown`, `scoreReasoning`, `scoreTrace`, and employer analysis data; present as triage, not a generic diagnostics dump. |
| Readiness state with concrete missing prerequisites | The user must know whether a job can enter apply review and what blocks it. | MEDIUM | Must be a shared API/contract fact used by Jobs drawer and Apply Review. |
| Hard blockers and eligibility concerns | Users need to distinguish "not a fit" from "system material missing" and "apply cannot proceed." | MEDIUM | Use scoring eligibility, stage/error blockers, application URL/material availability, and quality/judge blockers with clear lifecycle labels. |
| Rendered resume remains central in Apply Review | The user wants to inspect the artifact they may approve, not an abstract summary. | HIGH | Rework layout around the resume preview and pin inspector rather than moving evidence into a detached ledger. |
| Source-to-tailored change inspection | Users need to see what changed from profile/resume into generated material. | MEDIUM | Existing `annotatedChanges` and `bulletProvenance` provide a strong base. |
| Grounding and claim-risk visibility | Users need to know whether generated claims are supported, adjacent, unsupported, or risky. | HIGH | Use `quality`, `judge`, `adversarialReview`, `reviewFeedback`, and per-bullet provenance data. |
| Honest empty/missing states | Audit surfaces must not silently disappear when data is absent. | LOW | Existing inspector has this pattern; preserve it for pins/readiness. |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Resume pins tied to provenance rows | Makes trust inspectable at the exact claim level. | HIGH | Start with generated bullet/change anchors and a side inspector. |
| One shared readiness/blocker contract | Prevents contradictory UI labels and makes QA deterministic. | MEDIUM | Add contract/API field first, then consume in both surfaces. |
| Lifecycle-aware warnings | Distinguishes repair-attempt warnings, residual accepted warnings, and post-acceptance audit findings. | MEDIUM | Existing `reviewFeedback` fields help; display labels must be clear. |
| Drawer-to-review handoff | Lets ranking/readiness triage hand off to generated-material inspection without duplicating every detail. | LOW | Existing Apply Review can open `JobDetailDrawer`; Jobs drawer can link to Apply Review once the selected target is URL-addressable. |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Option 2 Evidence Ledger as milestone implementation | It makes evidence feel comprehensive. | It moves attention away from the rendered artifact the user approves. | Use Option 1 pins with a focused inspector; keep ledger as future comparison. |
| Option 3 Gate Timeline as milestone implementation | It explains process sequence. | It does not solve source-to-claim review on the resume. | Use readiness summary plus pins; timeline remains future comparison. |
| Blind auto-apply safety pitch in UI | It reinforces positioning. | User explicitly deferred this to README/docs positioning later. | Leave product copy/docs for a later milestone. |
| Real material regeneration during QA | It proves realism. | It can touch sensitive data and worker-backed flows outside scope. | Use seeded API/browser fixtures and static generated-material samples. |
| Cosmetic relabeling of "not ready" states | It may quiet a symptom. | It does not explain why or fix source-of-truth disagreement. | Compute readiness reasons and blockers at the owning layer. |

## Feature Dependencies

```text
Shared readiness/blocker contract
    -> Jobs drawer readiness and blocker panel
    -> Apply Review readiness and blocker panel
    -> Browser QA for agreement across surfaces

Artifact tailoring explanation
    -> Resume pin model
        -> Pin inspector
            -> Apply Review rendered-resume audit UX

Score breakdown and employer analysis
    -> Jobs drawer ranking explanation
        -> Drawer-to-review handoff

Folded cleanup
    -> Clean verification commands and icon/config dependency state
        -> Lower-noise implementation and QA
```

### Dependency Notes

- **Shared contract must come before UI agreement checks:** If both surfaces compute readiness independently, tests can only assert two copies of logic.
- **Resume pins require artifact explanation data:** Pins should be derived from `bulletProvenance` and `annotatedChanges`, not handcrafted from the job post.
- **Jobs drawer ranking explanation is separate from material proof:** Jobs owns rank/readiness triage; Apply Review owns generated artifact inspection.
- **Cleanup should be early and narrow:** It removes stale v1.1 friction without becoming the milestone's core feature.

## MVP Definition

### Launch With (v1.2)

- [ ] Narrow cleanup of stale v1.1 verification/config/dependency leftovers.
- [ ] Shared readiness/blocker DTO served to both `JobDetail` and `ApplyReviewQueueItem`.
- [ ] Jobs drawer audit triage: rank explanation, readiness, blockers, eligibility concerns.
- [ ] Apply Review centered on rendered resume/material with pin affordances and selected-pin inspector.
- [ ] Pin detail showing source evidence, tailored text, transform/change type, grounding status, claim risk, and reviewer action when available.
- [ ] Synthetic product-path QA that proves both surfaces agree and no apply submission path runs.

### Add After Validation

- [ ] Dedicated evidence ledger if users need bulk comparison beyond pin inspection.
- [ ] Gate timeline if users need lifecycle sequence debugging after the audit surfaces are usable.
- [ ] Deep PDF coordinate annotation if text/change anchors are not sufficient.
- [ ] README/docs positioning for why JobHunter is safer than blind auto-apply tools.

### Future Consideration

- [ ] Multi-artifact side-by-side diff for resume versions.
- [ ] Reviewer annotations/comments attached to individual pins.
- [ ] Exportable audit packet for a selected application.

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Shared readiness/blocker contract | HIGH | MEDIUM | P1 |
| Jobs drawer ranking/readiness triage | HIGH | MEDIUM | P1 |
| Apply Review resume pins | HIGH | HIGH | P1 |
| Pin inspector with grounding/risk detail | HIGH | MEDIUM | P1 |
| Folded cleanup | MEDIUM | LOW | P1 |
| Evidence ledger | MEDIUM | MEDIUM | P3 |
| Gate timeline | MEDIUM | MEDIUM | P3 |
| Blind auto-apply safety docs | MEDIUM | LOW | P3 |

## Sources

- User-selected sketch: `.planning/sketches/002-layered-audit-surfaces/` Option 1.
- User stories and scope split from QA comments on 2026-06-11.
- `apps/web/src/views/jobs/JobDetailDrawer.tsx` for current Jobs overlay.
- `apps/web/src/views/apply-review/ApplyReviewView.tsx` for current Apply Review material surface.
- `apps/web/src/contexts/materials/components/TailoringExplanationSection.tsx` and `BulletProvenanceList.tsx` for existing material audit capabilities.
- `packages/contracts/src/schemas.ts` for score, readiness, artifact, tailoring, and provenance DTO inventory.

---
*Feature research for: v1.2 Apply Review Audit UX - Drawer + Resume Pins*
*Researched: 2026-06-11*
