# Project Research Summary

**Project:** JobHunter - Grounded Resume Tailoring
**Domain:** Local-first job-application audit UX
**Researched:** 2026-06-11
**Confidence:** HIGH for scope and repo architecture, MEDIUM for exact resume-pin rendering mechanics

## Executive Summary

Milestone v1.2 should implement Sketch 002 Option 1: Drawer + Resume Pins. The current code already has the right raw ingredients: Jobs has a row-click `JobDetailDrawer` with score, stage, artifact, employer-analysis, and audit history sections; Apply Review has queue state, material preview, PDF/text preview, and the shared `ArtifactTailoringInspector`; artifact details already carry `annotatedChanges`, `bulletProvenance`, keyword coverage, judge, quality, voice-pass, and adversarial audit data.

The main gap is ownership and shape. Jobs drawer needs to become a rank/readiness/blocker triage surface. Apply Review needs to make the rendered resume the center of inspection, with pins that reveal source-to-tailored changes and claim risk. Readiness and blocker facts must move out of duplicated UI derivation and into one shared API/contract object consumed by both surfaces.

The milestone should start with the folded v1.1 cleanup, then build the shared contract, then implement Jobs drawer triage, then Apply Review resume pins, and finally run synthetic product-path QA. Do not broaden into auto-apply, worker execution, route redesign, Option 2/3 implementation, or blind-auto-apply positioning copy.

## Key Findings

### Recommended Stack

Use the existing stack. No new runtime dependency is justified for the MVP.

**Core technologies:**
- React 19 + Vite 7: existing UI/build stack for route and drawer changes.
- TypeScript + `@jobhunter/contracts`: required to keep shared readiness/blocker DTOs consistent across API and web.
- Tailwind 4 + shadcn/Radix primitives: v1.1 visual foundation; v1.2 should not add a parallel design layer.
- TanStack Query through Operations hooks: existing read-side pattern; views must not call API clients directly.
- SQLite projection-backed API read model: right owner for cross-surface readiness and blocker facts.

### Expected Features

**Must have:**
- Jobs drawer explains why the job ranked as it did.
- Jobs drawer and Apply Review show the same readiness and blocker facts.
- Hard blockers and eligibility concerns are explicit.
- Apply Review keeps the rendered resume/material central.
- Resume claims/rows have pins or markers that open source evidence, tailored text, transform/change type, grounding status, claim risk, and reviewer action when available.
- Missing audit data stays visible as an explicit state.
- QA uses synthetic data and avoids auto-apply/submission/worker-backed actions.

**Should have after validation:**
- Evidence Ledger as an optional bulk-comparison view.
- Gate Timeline as an optional lifecycle-debug view.
- Deeper PDF coordinate annotation if text/provenance anchors are insufficient.
- README/docs copy explaining why JobHunter is safer than blind auto-apply tools.

### Architecture Approach

The architecture should be contract-first: add a shared readiness/blocker DTO to `@jobhunter/contracts`, compute it in API read-model code, and surface it through both `JobDetail` and `ApplyReviewQueueItem`. Jobs and Apply Review remain view composers. Materials context owns reusable provenance/pin components derived from `ArtifactTailoringExplanation`.

**Major components:**
1. Shared readiness/blocker contract - one source of truth for readiness, missing prerequisites, eligibility concerns, and blockers.
2. Jobs drawer audit triage - ranking explanation, readiness, blockers, eligibility, and handoff.
3. Resume pin model and inspector - generated claim to source evidence, transform, grounding, risk, and action.
4. Synthetic QA fixtures and browser proof - seeded validation without touching sensitive data or submit flows.

### Critical Pitfalls

1. **Contradictory readiness labels** - prevent with one API/read-model contract, not local UI status functions.
2. **Ranking explanation in the wrong surface** - keep ranking in the Jobs row-click drawer.
3. **Decorative pins** - every pin must open concrete source/generated/risk details.
4. **Hidden missing audit data** - preserve explicit missing-source states and fix owning layers.
5. **Sensitive/live QA** - use synthetic seeded data and avoid auto-apply/submission paths.
6. **Cleanup scope creep** - keep folded v1.1 cleanup narrow and early.

## Implications for Roadmap

### Phase 12: Folded Cleanup + Verification Baseline

**Rationale:** Close v1.1 residue before introducing new audit UX code.
**Delivers:** Stale command cleanup, dependency/config audit, optional lucide removal if import proof allows, docs/config normalization.
**Addresses:** Cleanup requirements only.
**Avoids:** Scope creep and verification noise.

### Phase 13: Shared Apply Audit Contract

**Rationale:** Cross-surface facts must be owned before either UI changes.
**Delivers:** Shared readiness/blocker/eligibility DTO, API read-model mapping, tests, and web consumption path.
**Addresses:** Readiness agreement, blocker source of truth, eligibility concerns.
**Avoids:** Contradictory labels and UI-only status derivation.

### Phase 14: Jobs Drawer Audit Triage

**Rationale:** User clarified that the job overlay is the Jobs row-click popup/drawer.
**Delivers:** Drawer information architecture for why ranked, readiness, blockers, eligibility, and handoff.
**Uses:** Existing `ScoreBreakdown`, score fields, employer analysis, stage state, artifacts, and shared contract.
**Avoids:** Implementing ranking explanation only in Apply Review.

### Phase 15: Apply Review Resume Pins

**Rationale:** Apply Review owns generated-material proof and must center the rendered resume.
**Delivers:** Resume pin model, pin affordances, selected-pin inspector, grounding/risk/action detail, and honest missing states.
**Uses:** `ArtifactTailoringExplanation`, `annotatedChanges`, `bulletProvenance`, keyword coverage, quality, judge, adversarial review, and review feedback.
**Avoids:** Decorative pins and detached evidence dumps.

### Phase 16: Product-Path QA + Docs

**Rationale:** User-facing UX work needs browser proof and test coverage, not just typecheck.
**Delivers:** API/web tests, seeded browser QA, a11y checks where relevant, docs updates for changed QA/product behavior, final milestone audit readiness.
**Avoids:** Sensitive data exposure and accidental apply/submission flows.

### Phase Ordering Rationale

- Cleanup first reduces noise but remains small.
- Shared contract precedes UI work so both surfaces consume the same facts.
- Jobs drawer precedes Apply Review pins because rank/readiness triage is separate from material proof.
- Apply Review pins come after the artifact/source contract is understood.
- QA/docs close the loop after both surfaces are implemented.

### Research Flags

Phases likely needing deeper design/technical validation during planning:
- **Phase 13:** Final DTO shape and exact blocker/eligibility source precedence.
- **Phase 15:** Whether pin anchors can be attached directly to PDF preview, text preview, or a side rail without brittle coordinates.
- **Phase 16:** Best seeded QA path for showing both surfaces without exposing local artifacts.

Phases with standard patterns:
- **Phase 12:** Mechanical cleanup and docs/config audit.
- **Phase 14:** Existing drawer composition and score components provide most building blocks.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Current repo packages and scripts define the implementation stack. |
| Features | HIGH | User stories and selected Option 1 scope are explicit. |
| Architecture | HIGH | Repo frontend/API boundaries are documented and current code follows them. |
| Pin mechanics | MEDIUM | Existing provenance supports pins, but exact visual anchoring needs phase-level validation. |
| QA fixtures | MEDIUM | Synthetic QA is required; exact fixture path should be chosen during phase planning. |

**Overall confidence:** HIGH for milestone plan, MEDIUM for the PDF/pin implementation details until Phase 15 planning.

## Gaps to Address

- **Shared DTO naming and fields:** Decide during Phase 13 planning, but preserve the invariant that both surfaces consume the same facts.
- **Pin location model:** Validate whether pins attach to text rows, PDF preview side rail, or generated bullet list before coding.
- **Risk severity mapping:** Define how quality/judge/adversarial signals collapse into pin-level `grounded`, `warning`, `unsupported`, or `missing_source` display states.
- **Synthetic QA data:** Use or add fixtures that prove blockers, ready state, missing source, grounded claim, and risky claim states.

## Sources

### Primary

- `AGENTS.md` - repo workflow, frontend boundaries, auditability, and QA safety rules.
- `docs/frontend-target.md` - frontend architecture and view/context separation.
- `apps/web/src/views/jobs/JobDetailDrawer.tsx` - Jobs row-click drawer implementation.
- `apps/web/src/views/apply-review/ApplyReviewView.tsx` - Apply Review surface and current status derivation.
- `apps/web/src/contexts/materials/components/ArtifactTailoringInspector.tsx`
- `apps/web/src/contexts/materials/components/TailoringExplanationSection.tsx`
- `apps/web/src/contexts/materials/components/BulletProvenanceList.tsx`
- `packages/contracts/src/schemas.ts`
- `apps/api/src/application-feedback.ts`
- `apps/api/src/read-model.ts`
- `.planning/sketches/002-layered-audit-surfaces/`

---
*Research completed: 2026-06-11*
*Ready for roadmap: yes*
