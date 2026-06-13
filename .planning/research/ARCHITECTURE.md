# Architecture Research

**Domain:** Local-first job-application audit UX
**Researched:** 2026-06-11
**Confidence:** HIGH for ownership boundaries, MEDIUM for final pin-rendering component shape

## Standard Architecture

### System Overview

```text
User clicks job row
    -> Jobs view composer
        -> JobDetailDrawer
            -> useJobDetailQuery
                -> GET job detail read model
                    -> JobSummary + ScoreBreakdown + SharedApplyAudit + artifacts

User opens Apply Review
    -> ApplyReviewView
        -> useApplyReviewQueueQuery
            -> GET apply review queue read model
                -> ApplyReviewQueueItem + SharedApplyAudit + material previews
        -> Resume audit surface
            -> ArtifactTailoringInspector / pin model
                -> useArtifactDetailQuery
                    -> ArtifactTailoringExplanation
```

### Component Responsibilities

| Component | Responsibility | Current / Planned Implementation |
|-----------|----------------|----------------------------------|
| API read model | Own readiness, blockers, eligibility/readiness reasons, and DTO shape | Extend `@jobhunter/contracts`, `application-feedback.ts`, and `read-model.ts`; do not duplicate in views. |
| Jobs drawer | Triage whether this job is worth/apply-ready and why it ranked this way | Refactor `JobDetailDrawer` sections around rank, readiness, blocker, and handoff panels. |
| Apply Review | Inspect the generated artifact before approval | Rework `ApplyReviewView` so rendered resume is central and pins drive detail inspection. |
| Materials context | Own artifact tailoring explanation rendering and reusable provenance widgets | Extend `ArtifactTailoringInspector`, `TailoringExplanationSection`, or new context-owned components for pin data. |
| Operations hooks | Fetch read-side data | Continue `useJobDetailQuery`, `useApplyReviewQueueQuery`, and `useArtifactDetailQuery`; views do not call `apiClient` directly. |
| Shared UI primitives | Visual controls and surfaces | Use existing shadcn/Radix primitives and Tabler icons. |

## Recommended Project Structure

```text
packages/contracts/src/
  schemas.ts                         # shared readiness/blocker and optional pin DTOs

apps/api/src/
  application-feedback.ts            # apply queue item mapping and shared audit derivation
  read-model.ts                      # job detail mapping with same shared audit contract
  *.test.ts                          # API/read-model contract tests

apps/web/src/contexts/apply/
  components/ApplyReadinessPanel.tsx # shared readiness/blocker display if owned by Apply
  lib/apply-readiness.ts             # formatting only, no source-of-truth logic

apps/web/src/contexts/materials/
  components/ResumeAuditPins.tsx     # artifact provenance pins and selected-pin inspector
  components/ResumePinInspector.tsx  # selected claim/source/risk detail
  lib/resume-pin-model.ts            # maps artifact explanation to UI pin model

apps/web/src/views/jobs/
  JobDetailDrawer.tsx                # composer for ranking/readiness/blocker sections
  JobRankAuditPanel.tsx              # view-local composition of scoring components

apps/web/src/views/apply-review/
  ApplyReviewView.tsx                # composer for queue, selected job, and rendered resume audit surface

apps/web/e2e/tests/
  apply-review-audit.spec.ts         # seeded product-path QA
```

### Structure Rationale

- **Contracts first:** The readiness/blocker facts are cross-surface data, so they belong in shared contracts and API mappers before UI work.
- **Context-owned reusable audit pieces:** Materials provenance is not Apply Review-specific; resume-pin data should live near existing materials inspector logic.
- **Views as composers:** Jobs and Apply Review views assemble panels but should not own server queries, API clients, or cross-context state.
- **Small cleanup phase first:** Stale v1.1 cleanup reduces verification noise before feature work.

## Architectural Patterns

### Pattern 1: Shared Read Contract

**What:** A single DTO, for example `ApplyAuditReadiness`, describes readiness kind, label, blockers, eligibility concerns, missing prerequisites, and source/lifecycle metadata.

**When to use:** Any fact that appears in both Jobs drawer and Apply Review.

**Trade-offs:** Adds API/contract work up front, but prevents UI disagreement and makes QA assert one source of truth.

```typescript
interface ApplyAuditReadiness {
  state: "ready" | "preparing" | "blocked" | "repair";
  label: string;
  summary: string;
  missingPrerequisites: string[];
  blockers: string[];
  eligibilityConcerns: string[];
  sources: Array<{ kind: string; id: string | null }>;
}
```

The final shape should be planned in Phase 13; the important invariant is shared ownership, not this exact interface.

### Pattern 2: Pin Model Derived From Artifact Explanation

**What:** Convert `ArtifactTailoringExplanation` into stable UI pins keyed by `bulletId`, `sourceId`, section, and generated text.

**When to use:** Apply Review resume claim inspection.

**Trade-offs:** Text/bullet anchors are less visually exact than PDF coordinates, but they are safer and grounded in existing canonical provenance. Coordinate overlays can be added later if necessary.

```typescript
type ResumeAuditPin = {
  id: string;
  section: string;
  generatedText: string;
  sourceText: string[];
  transformType: string;
  evidenceIds: string[];
  requirementIds: string[];
  risk: "grounded" | "warning" | "unsupported" | "missing_source";
};
```

### Pattern 3: Honest Missing States

**What:** Components render explicit "not recorded" / "no source captured" states instead of blank panels.

**When to use:** Any provenance, score, judge, prompt, or blocker data that may be absent.

**Trade-offs:** The UI may show uncomfortable gaps, but this is core product value and aligns with the repository auditability discipline.

## Data Flow

### Readiness Flow

```text
Projection rows and latest apply/material state
    -> API readiness/blocker derivation
        -> Shared contract in JobDetail and ApplyReviewQueueItem
            -> Jobs drawer readiness panel
            -> Apply Review readiness panel and queue tags
                -> Tests assert identical facts for the same job
```

### Resume-Pin Flow

```text
Artifact detail
    -> ArtifactTailoringExplanation
        -> pin model derived from bulletProvenance + annotatedChanges + judge/quality/adversarial data
            -> rendered resume preview with pin markers
            -> selected pin inspector with source, generated text, transform, grounding, risk, action
```

### Ranking Flow

```text
Job detail
    -> JobSummary score fields + ScoreBreakdown + ScoreTrace + EmployerAnalysis
        -> Jobs drawer rank audit panel
            -> requirements/matched/missing/transferable/eligibility display
            -> handoff to Apply Review for material proof
```

## Anti-Patterns

### Anti-Pattern 1: UI-Only Readiness

**What people do:** Derive status labels independently in `ApplyReviewView`, `JobDetailDrawer`, and queue cards.

**Why it is wrong:** It creates contradictory "ready" and "not ready" labels and hides the actual blocker source.

**Do this instead:** Compute/read the readiness contract once in the API/read model and use UI helpers only for formatting.

### Anti-Pattern 2: Resume Pins Without Canonical Anchors

**What people do:** Place visual markers by guessed PDF coordinates or line indexes without a canonical link to provenance.

**Why it is wrong:** Pins drift when rendering changes and can imply proof for the wrong claim.

**Do this instead:** Anchor pins to generated text/provenance rows first; show "not located in preview" when an anchor cannot be matched.

### Anti-Pattern 3: Evidence Suppression

**What people do:** Hide missing, unsupported, or risky sections to keep the UI clean.

**Why it is wrong:** It directly undermines trust and violates the auditability rule.

**Do this instead:** Show explicit missing-source states and add source computation/persistence at the owning layer when the data should exist.

## Integration Points

| Boundary | Communication | Notes |
|----------|---------------|-------|
| API -> web contracts | `@jobhunter/contracts` DTOs | Shared readiness/blocker additions must be backward-compatible within the local app and covered by typecheck/tests. |
| API read model -> Apply Review | `useApplyReviewQueueQuery` | Queue tags and selected view should consume shared readiness rather than local `materialStatus`. |
| API read model -> Jobs drawer | `useJobDetailQuery` | Job detail should expose the same readiness/blocker facts when possible. |
| Materials -> Apply Review | `useArtifactDetailQuery` | Resume pins can reuse artifact tailoring explanation data; no worker execution needed for QA. |
| Browser QA -> seeded API data | Synthetic fixtures | Do not run auto-apply, browser submission, mailbox scanning, real generation, or destructive local data actions. |

## Sources

- `docs/frontend-target.md` and `AGENTS.md` frontend conventions for view/context boundaries.
- `apps/web/src/views/jobs/JobDetailDrawer.tsx`
- `apps/web/src/views/apply-review/ApplyReviewView.tsx`
- `apps/web/src/contexts/materials/components/ArtifactTailoringInspector.tsx`
- `apps/web/src/contexts/materials/components/TailoringExplanationSection.tsx`
- `apps/web/src/contexts/materials/components/BulletProvenanceList.tsx`
- `apps/api/src/application-feedback.ts`
- `apps/api/src/read-model.ts`
- `packages/contracts/src/schemas.ts`

---
*Architecture research for: v1.2 Apply Review Audit UX - Drawer + Resume Pins*
*Researched: 2026-06-11*
