# JobHunter - Grounded Resume Tailoring

## What This Is

JobHunter is a local-first job-search automation app with a TypeScript API, React/Vite web app, and Python Temporal worker. It runs a discovery -> enrichment -> scoring -> tailoring -> cover -> apply pipeline over local SQLite and generated artifacts, with resume tailoring treated as a trust-first workflow: generated materials must remain grounded, inspectable, and reviewable before any apply action.

## Core Value

A user can trust every line of a tailored resume because each bullet traces visibly to a real profile fact and a specific job requirement, with the reasoning and transform rule available for review.

## Current State

**Shipped milestone:** v1.2 Apply Review Audit UX - Drawer + Resume Pins (2026-06-13)

v1.2 made the audit path inspectable across the two surfaces where users decide whether a job and generated materials are ready:

- Jobs drawer explains why a job ranked where it did, whether it is ready for apply review, and which missing prerequisites, hard blockers, or eligibility concerns exist.
- Apply Review centers the rendered resume/material and exposes source-backed line and claim inspection for generated-material review.
- Jobs drawer and Apply Review consume one shared `ApplyAudit` readiness/blocker/eligibility contract from the API/read model.
- The Jobs drawer to Apply Review handoff preserves the selected job through the route search state.
- The folded v1.1 cleanup removed obsolete `lucide-react` usage and normalized final Tailwind 4/shadcn token, icon, font, and QA expectations.

No active milestone is currently defined. The next milestone should start with fresh requirements via `$gsd-new-milestone`.

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
- [x] v1.1 shadcn/token migration through Phases 6-10 - semantic tokens, shared primitives, layout chrome, Tabler icons, status semantics, and route visual QA landed via PRs #151-#155; remaining cleanup was folded into v1.2.
- [x] v1.2 Apply Review Audit UX - Drawer + Resume Pins - folded cleanup, shared apply audit contract, Jobs drawer audit triage, Apply Review resume pins, same-job handoff, and product-path QA shipped on 2026-06-13. See `.planning/milestones/v1.2-REQUIREMENTS.md` and `.planning/milestones/v1.2-MILESTONE-AUDIT.md`.

### Active

None. New active requirements should be defined in the next milestone.

### Out of Scope

<!-- Explicit boundaries with reasoning to prevent re-adding. -->

- Option 2 Evidence Ledger and Option 3 Gate Timeline - comparison sketches only, deferred from v1.2.
- Reviewer comments or annotations attached to individual resume pins - useful future audit workflow.
- Exportable audit packets for selected applications - future audit/reporting scope.
- Deep PDF coordinate annotation - deferred unless text/provenance anchors prove insufficient.
- "Why JobHunter is safer than blind auto-apply tools" as a UI surface - deferred to README/docs positioning later.
- Auto-apply, browser submission, mailbox scanning, real generated-material regeneration, destructive profile/database actions, or worker-backed jobs unless explicitly requested.
- Broad route redesign, new scoring/tailoring policy redesign, worker automation expansion, marketing dashboard treatment, or landing-page work.
- Hiding or suppressing missing audit data as a substitute for fixing the source of truth.
- Re-opening the v1.1 visual-system migration beyond narrow maintenance.

## Context

- **Current web stack:** React 19, Vite 7, Tailwind CSS 4, `@tailwindcss/vite`, shadcn/Radix copied primitives under `apps/web/src/shared/ui`, TanStack Router/Query/Table/Form, Zustand UI preferences, Vitest, Playwright, Storybook, and axe-based accessibility tests.
- **Current API/worker stack:** TypeScript API over projection-backed local read models plus Python Temporal worker and JSON-RPC worker integration.
- **Current token/icon state:** The app uses the shadcn semantic token stack from v1.1. `apps/web/components.json` uses `style: "radix-luma"`, `iconLibrary: "tabler"`, and no Tailwind config file. `lucide-react` was removed after source import proof.
- **Audit surface state:** `ApplyAudit` is the shared read contract for readiness, missing prerequisites, blockers, eligibility concerns, lifecycle/source metadata, and review evidence availability. Jobs drawer and Apply Review both consume this contract.
- **Route state:** Apply Review supports route-selected jobs via `/apply-review?jobKey=<jobKey>`, allowing Jobs drawer handoff to preserve the selected job.
- **Archive state:** v1.2 roadmap, requirements, audit, and phase execution artifacts are archived under `.planning/milestones/`.

## Constraints

- **Architecture:** Follow the frontend target architecture: views compose context components; contexts do not import views; shared UI owns primitives; operations owns read-side hooks and invalidation.
- **Local-first safety:** Do not expose profile data, resumes, generated PDFs, browser profiles, logs, SQLite databases, API keys, OAuth tokens, or application artifacts in screenshots, stories, fixtures, docs, or commits.
- **Auditability:** Every displayed claim must have an explicit source of truth. If the correct source is missing, compute or persist it at the owning layer; do not hide the UI field as a substitute for correct evidence.
- **Product safety:** Do not start auto-apply, browser submission, mailbox scanning, real material generation, destructive profile/database actions, or worker-backed jobs unless the user explicitly asks.
- **QA:** User-facing Apply Review, Jobs drawer, audit, or browser-flow changes require product-path QA, not only typecheck. Use synthetic or seeded data and include browser proof for the relevant routes.
- **Scope discipline:** Keep changes as small as practical per phase. Do not combine broad redesign, worker execution, or new policy behavior with focused audit-surface changes.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Choose Sketch 002 Option 1: Drawer + Resume Pins | Keeps the existing Jobs drawer interaction and makes generated-material proof inspectable on the rendered resume | Good - shipped in v1.2 |
| Define "job overlay" as the Jobs row-click drawer (`JobDetailDrawer`) | Prevents ranking/readiness work from drifting into Apply Review | Good - Jobs drawer owns ranking/readiness triage |
| Keep Apply Review centered on the rendered resume/material | The user needs to inspect what actually changed and whether generated claims are grounded | Good - shipped in v1.2 |
| Share readiness and eligibility facts across Jobs drawer and Apply Review | The same job cannot be "ready" in one surface and blocked in another without a source-of-truth bug | Good - `ApplyAudit` is shared |
| Preserve selected job identity in route state for cross-surface handoff | Cross-view audit handoff must continue the same job, not default to queue order | Good - `/apply-review?jobKey=<jobKey>` shipped |
| Fold v1.1 Phase 11 cleanup into v1.2 as housekeeping | Cleanup was small and should not block the audit UX milestone, but stale config/dependency/docs needed closure | Good - shipped in Phase 12 |
| Defer blind-auto-apply safety positioning to README/docs | The chosen UI milestone was about audit surfaces; positioning copy belongs in docs later | Deferred |
| v1.0 grounded resume tailoring architecture is validated | Milestone verification on 2026-06-09 showed all 26 requirements mapped and verified | Good |

## Archived Milestone Briefs

<details>
<summary>v1.2 Apply Review Audit UX - Drawer + Resume Pins</summary>

**Goal:** Make the existing Jobs row-click drawer and Apply Review rendered-resume surface explain the audit trail clearly enough that a technical job seeker can understand ranking, readiness, blockers, material changes, grounding, and claim risk before any apply approval.

**Chosen design direction:** Sketch 002, Option 1: Drawer + Resume Pins.

**Delivered:**

- Folded v1.1 cleanup and verification baseline.
- Shared Apply Review readiness/blocker/eligibility contract.
- Jobs drawer audit triage.
- Apply Review rendered-resume pins.
- Product-path QA and documentation.
- Same-job Jobs drawer to Apply Review handoff.

See `.planning/milestones/v1.2-ROADMAP.md` and `.planning/milestones/v1.2-REQUIREMENTS.md`.

</details>

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition**:
1. Requirements invalidated? -> Move to Out of Scope with reason.
2. Requirements validated? -> Move to Validated with phase reference.
3. New requirements emerged? -> Add to Active.
4. Decisions to log? -> Add to Key Decisions.
5. "What This Is" still accurate? -> Update if drifted.

**After each milestone**:
1. Full review of all sections.
2. Core Value check - still the right priority?
3. Audit Out of Scope - reasons still valid?
4. Update Context with current state.

---
*Last updated: 2026-06-13 after v1.2 milestone completion*
