# JobHunter - Grounded Resume Tailoring

## What This Is

JobHunter is a local-first job-search automation app with a TypeScript API, React/Vite web app, and Python Temporal worker. It runs a discovery -> enrichment -> scoring -> tailoring -> cover -> apply pipeline over local SQLite and generated artifacts, with resume tailoring treated as a trust-first workflow: generated materials must remain grounded, inspectable, and reviewable before any apply action.

## Core Value

A user can trust every line of a tailored resume because each bullet traces visibly to a real profile fact and a specific job requirement, with the reasoning and transform rule available for review.

## Current Milestone: v1.2 Apply Review Audit UX - Drawer + Resume Pins

**Goal:** Make the existing Jobs row-click popup/drawer and the Apply review rendered-resume surface explain the audit trail clearly enough that a technical job seeker can understand ranking, readiness, blockers, material changes, grounding, and claim risk before any apply approval.

**Chosen design direction:** Sketch 002, Option 1: Drawer + Resume Pins.

**Target features:**
- Fold in the remaining v1.1 cleanup as a small early housekeeping slice: remove obsolete dependency/config remnants, normalize stale verification commands, and document final shadcn token/icon/font expectations.
- Treat the Jobs overlay as the existing Jobs view popup/drawer opened after clicking a job row (`JobDetailDrawer`), not an apply-review queue panel.
- Make the Jobs drawer explain why the job was ranked the way it was, whether it is ready for apply review, and what hard blockers or eligibility concerns exist.
- Treat Apply review as the surface that shows the actual rendered resume/material, not another generic summary panel.
- Make Apply review show hard blockers or eligibility concerns, readiness, source-to-artifact changes, and whether generated claims are grounded or risky.
- Use one shared readiness and eligibility/blocker contract across Jobs drawer and Apply review so the two surfaces cannot disagree.
- Keep the rendered resume as the central review object, with row/claim pins that reveal source evidence, tailored text, transform/change type, grounding status, claim risk, and reviewer action.

## Requirements

### Validated

<!-- Shipped and relied upon. -->

- [x] Discovery pipeline scrapes jobs from external boards (python-jobspy) - existing.
- [x] Enrichment verifies and snapshots postings - existing.
- [x] Scoring evaluates job fit with LLM plus scoring policy - existing.
- [x] Resume tailoring stage (`tailor`) generates resume artifacts and audit evidence via the Materials context - existing.
- [x] Cover-letter generation stage (`cover`) - existing.
- [x] Apply stage runs browser/agent submission automation when explicitly invoked - existing.
- [x] JSON-RPC tailoring actions: `tailor_job`, `retailor_job`, `retailor_current_policy` - existing.
- [x] PDF rendering of generated materials via LaTeX and Playwright HTML paths - existing.
- [x] Projection-backed read model, SSE realtime, and audit/event backbone (`job_events`) - existing.
- [x] Profile import and canonical profile data store - existing.
- [x] Materials, apply-review, and artifacts web surfaces - existing.
- [x] v1.0 grounded resume tailoring milestone - employer analysis, per-bullet provenance, granular controls, voice pass, canonical read model, generate-materials wiring, and inspector UI verified on 2026-06-09. See `.planning/MILESTONE-ACCEPTANCE.md`.
- [x] v1.1 shadcn/token migration through Phases 6-10 - semantic tokens, shared primitives, layout chrome, Tabler icons, status semantics, and route visual QA landed via PRs #151-#155. The remaining cleanup slice is folded into v1.2.

### Active

<!-- Current milestone scope. Hypotheses until shipped and validated. -->

**Pillar A - v1.1 cleanup folded into v1.2**

- [ ] Obsolete dependency/config remnants from the shadcn/token migration are audited and removed only when import/config proof shows they are unused.
- [ ] Stale verification commands are normalized to the current project structure, including removing references to `apps/web/tailwind.config.ts` now that Tailwind 4 CSS-first config is in use.
- [ ] Docs/config surfaces reflect the final shadcn token, icon, font, and QA expectations without re-opening visual-system scope.

**Pillar B - Jobs drawer audit triage**

- [ ] Opening a job from the Jobs table shows a drawer/popup that explains why the job was ranked the way it was.
- [ ] The same drawer shows whether the job is ready for apply review, with the concrete missing prerequisites when it is not.
- [ ] The drawer exposes hard blockers or eligibility concerns as audit facts, not ambiguous status tags.
- [ ] The drawer links or hands off to Apply review only for generated-material inspection, not for ranking explanation.

**Pillar C - Rendered resume pins and material audit**

- [ ] Apply review keeps the rendered resume/material as the central review object.
- [ ] Resume rows or generated claims expose pins/markers that reveal source profile/resume evidence and the tailored artifact text.
- [ ] Pin details show the transform/change type, grounding status, claim risk, and reviewer action where applicable.
- [ ] Generated claims that are adjacent, unsupported, risky, or missing source proof remain visibly reviewable rather than hidden or collapsed into a summary.

**Pillar D - Shared contract and QA**

- [ ] Readiness and eligibility/blocker facts come from one shared source/contract across Jobs drawer and Apply review.
- [ ] If a correct audit source is missing, the owning layer computes, derives, or persists it; UI copy must not hide, rename, or cosmetically suppress incomplete audit data.
- [ ] Product-path QA covers Jobs drawer, Apply review, readiness/blocker states, resume-pin inspection, seeded browser proof, and no auto-apply/browser submission.

### Out of Scope

<!-- Explicit boundaries with reasoning to prevent re-adding. -->

- Option 2 Evidence Ledger and Option 3 Gate Timeline - comparison sketches only, not implementation scope for v1.2.
- "Why JobHunter is safer than blind auto-apply tools" as a UI surface - deferred to README/docs positioning later.
- Auto-apply, browser submission, mailbox scanning, real generated-material regeneration, destructive profile/database actions, or worker-backed jobs unless explicitly requested later.
- Broad route redesign, new scoring/tailoring policy redesign, worker automation expansion, marketing dashboard treatment, or landing-page work.
- Hiding or suppressing missing audit data as a substitute for fixing the source of truth.
- Re-opening the v1.1 visual-system migration beyond the narrow folded cleanup slice.

## Context

- **Current web stack:** React 19, Vite 7, Tailwind CSS 4, `@tailwindcss/vite`, shadcn/Radix copied primitives under `apps/web/src/shared/ui`, TanStack Router/Query/Table/Form, Zustand UI preferences, Vitest, Playwright, Storybook, and axe-based accessibility tests.
- **Chosen sketch:** `.planning/sketches/002-layered-audit-surfaces/` Option 1: Drawer + Resume Pins. Option 1 keeps the existing Jobs drawer pattern and adds row-level proof on the rendered resume.
- **Jobs overlay definition:** The job overlay is the popup/drawer opened from the Jobs view after clicking a job row, currently represented by `JobDetailDrawer`.
- **Apply review definition:** Apply review is the surface that shows the actual rendered resume/material and review controls; it owns generated-material evidence inspection.
- **Shared audit contract:** Readiness and eligibility/blocker facts must be shared across the two surfaces. Differences in display are acceptable; disagreement in facts is not.
- **v1.1 cleanup snapshot:** Phases 6-10 landed via PRs #151-#155. Remaining cleanup is small: stale verification command normalization, dependency/config audit, obsolete `lucide-react` cleanup if import proof allows it, and docs/config updates.
- **Current token state:** The app now uses the shadcn semantic token stack from v1.1. `apps/web/components.json` uses `style: "radix-luma"`, `iconLibrary: "tabler"`, and an empty Tailwind config path. No production old-token references were found in the preflight scan, but cleanup proof still belongs in v1.2.

## Constraints

- **Architecture:** Follow the frontend target architecture: views compose context components; contexts do not import views; shared UI owns primitives; operations owns read-side hooks and invalidation. Jobs drawer work belongs in the Jobs view composer plus context-owned components/hooks; shared readiness logic belongs in the owning context/read model rather than duplicated local UI state.
- **Local-first safety:** Do not expose profile data, resumes, generated PDFs, browser profiles, logs, SQLite databases, API keys, OAuth tokens, or application artifacts in screenshots, stories, fixtures, docs, or commits.
- **Auditability:** Every displayed claim must have an explicit source of truth. If the correct source is missing, compute or persist it at the owning layer; do not hide the UI field as a substitute for correct evidence.
- **Product safety:** This milestone must not start auto-apply, browser submission, mailbox scanning, real material generation, destructive profile/database actions, or worker-backed jobs unless the user explicitly asks later.
- **QA:** User-facing Apply review and Jobs drawer changes require product-path QA, not only typecheck. Use synthetic or seeded data and include browser proof for the relevant routes.
- **Scope discipline:** Keep changes as small as practical per phase. Do not combine broad redesign, worker execution, or new policy behavior with the Drawer + Resume Pins milestone.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Choose Sketch 002 Option 1: Drawer + Resume Pins | Keeps the existing Jobs drawer interaction and makes generated-material proof inspectable on the rendered resume | - Pending |
| Define "job overlay" as the Jobs row-click drawer (`JobDetailDrawer`) | Prevents accidentally implementing the ranking/readiness story in Apply review instead of Jobs | - Pending |
| Keep Apply review centered on the rendered resume/material | The user needs to inspect what actually changed and whether generated claims are grounded | - Pending |
| Share readiness and eligibility facts across both surfaces | The same job cannot be "ready" in one surface and blocked in another without a source-of-truth bug | - Pending |
| Fold v1.1 Phase 11 cleanup into v1.2 as housekeeping | The cleanup is small and should not block the product audit milestone, but stale config/dependency/docs should be closed | - Pending |
| Defer blind-auto-apply safety positioning to README/docs | The chosen UI milestone is about audit surfaces; positioning copy belongs in docs later | - Deferred |
| v1.0 grounded resume tailoring architecture is validated | Milestone verification on 2026-06-09 showed all 26 requirements mapped and verified | Good |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? -> Move to Out of Scope with reason.
2. Requirements validated? -> Move to Validated with phase reference.
3. New requirements emerged? -> Add to Active.
4. Decisions to log? -> Add to Key Decisions.
5. "What This Is" still accurate? -> Update if drifted.

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections.
2. Core Value check - still the right priority?
3. Audit Out of Scope - reasons still valid?
4. Update Context with current state.

---
*Last updated: 2026-06-11 after initializing milestone v1.2 research, requirements, and roadmap*
