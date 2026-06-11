# Requirements: JobHunter - Apply Review Audit UX

**Defined:** 2026-06-11
**Milestone:** v1.2 Apply Review Audit UX - Drawer + Resume Pins
**Chosen sketch:** `.planning/sketches/002-layered-audit-surfaces/` Option 1: Drawer + Resume Pins
**Core Value:** A user can trust every line of a tailored resume because each bullet traces visibly to a real profile fact and a specific job requirement, with the reasoning and transform rule available for review.

## v1.2 Requirements

Requirements for this milestone. Each maps to exactly one roadmap phase unless explicitly marked as cross-phase QA.

### Cleanup And Baseline

- [x] **CLEAN-01**: Stale v1.1 verification commands and references are normalized to the current project structure, including removing outdated `apps/web/tailwind.config.ts` assumptions now that Tailwind 4 CSS-first config is in use.
- [x] **CLEAN-02**: Obsolete dependency/config remnants are audited and removed only when import/config proof shows they are unused; `lucide-react` removal is allowed only if source and package audits prove zero required imports.
- [x] **CLEAN-03**: Documentation/config owners are updated narrowly for final shadcn token, Tabler icon, font, and QA expectations without reopening visual-system migration scope.
- [x] **CLEAN-04**: Cleanup leaves no permanent styling or verification API based on removed legacy token names such as `--paper`, `--ink`, `--rule`, `bg-paper`, `text-ink`, `border-rule`, or `ring-info`.

### Shared Apply Audit Contract

- [x] **AUDIT-01**: A shared read contract describes apply-review readiness for a job, including state, label, summary, missing prerequisites, hard blockers, eligibility concerns, lifecycle/source metadata, and whether review evidence remains available.
- [x] **AUDIT-02**: The shared readiness and blocker facts are computed or derived at the owning API/read-model layer from canonical sources such as application URL, material availability, current stage/state/error, latest apply run, scoring eligibility, and material validation output where present.
- [x] **AUDIT-03**: `JobDetail` and `ApplyReviewQueueItem` expose the same shared readiness/blocker facts for the same job so Jobs drawer and Apply Review cannot disagree.
- [x] **AUDIT-04**: Web views use the shared contract for source facts; any local UI helper is formatting-only and cannot independently decide readiness, blocker, or eligibility status.
- [x] **AUDIT-05**: Missing readiness, blocker, or eligibility source data renders an explicit inspectable state rather than an empty panel, hidden tag, or cosmetic relabeling.
- [x] **AUDIT-06**: API and web tests cover at least ready, preparing, missing-apply-link, blocked/failed/stale, failed apply-run, and missing-source cases.

### Jobs Drawer Audit Triage

- [x] **DRAWER-01**: Opening a job from the Jobs view row-click popup/drawer immediately explains why the job was ranked the way it was.
- [x] **DRAWER-02**: The drawer rank explanation includes fit score, score band/confidence where available, matched signals, missing signals, transferable signals, keywords, score reasoning/trace where available, and eligibility status/concerns.
- [x] **DRAWER-03**: The drawer shows whether the job is ready for apply review and lists concrete missing prerequisites, hard blockers, and eligibility concerns from the shared apply audit contract.
- [x] **DRAWER-04**: The drawer distinguishes job-fit/ranking evidence from generated-material proof and hands off to Apply Review for resume/material inspection instead of duplicating the full resume audit surface.
- [x] **DRAWER-05**: Existing drawer workflows remain intact: close behavior, escape handling, job actions, retry affordances, artifact links, apply history, outcome panel, score correction, job description, and audit history continue to work.
- [x] **DRAWER-06**: Drawer layout remains dense, scannable, responsive, keyboard accessible, and compatible with light/dark themes and compact/regular/comfy density.

### Apply Review Resume Pins

- [ ] **REVIEW-01**: Apply Review keeps the rendered resume/material as the central review object rather than relegating it below detached audit cards.
- [ ] **REVIEW-02**: Resume rows or generated claims expose stable pins/markers derived from canonical artifact audit data, starting with `bulletProvenance` and `annotatedChanges`.
- [ ] **REVIEW-03**: Selecting a pin shows source profile/resume text, generated tailored artifact text, transform/change type, governing controls, requirement IDs, evidence IDs, matched keywords, and rationale where recorded.
- [ ] **REVIEW-04**: Pin details show grounding and claim-risk status using quality, judge, adversarial review, coverage, and review-feedback signals where available.
- [ ] **REVIEW-05**: Pins preserve honest lifecycle labels: repair attempted, accepted with residual warnings, skipped audit, no source recorded, unsupported claim, missing required evidence, and no provenance recorded remain visibly distinct when those states apply.
- [ ] **REVIEW-06**: The Apply Review readiness/header and decision controls consume the shared apply audit contract and explain blockers without contradicting the Jobs drawer.
- [ ] **REVIEW-07**: Cover-letter and text/PDF fallback states remain reviewable; missing PDF or missing provenance shows explicit empty states rather than blank space.
- [ ] **REVIEW-08**: Resume-pin interactions are keyboard accessible, have stable dimensions, do not overlap text/content at supported viewport sizes, and remain usable in light/dark themes.

### QA, Safety, And Documentation

- [ ] **QA-01**: Required API/web checks pass for touched surfaces, including typecheck, build, targeted API/read-model tests, web unit/component tests, and additional type-level/Storybook/a11y checks where component shape warrants them.
- [ ] **QA-02**: Product-path browser QA proves the Jobs drawer stories: why ranked, readiness, blockers, eligibility concerns, and drawer-to-review handoff.
- [ ] **QA-03**: Product-path browser QA proves Apply Review stories: readiness agreement, rendered resume focus, pin selection, source-to-tailored change detail, grounded claim, risky/unsupported claim, and missing-source state.
- [ ] **QA-04**: QA fixtures, stories, screenshots, and docs use synthetic or seeded data only and do not expose profile data, resumes, generated PDFs, application data, browser profiles, logs, SQLite databases, API keys, or OAuth tokens.
- [ ] **QA-05**: No QA stage runs auto-apply, browser submission, mailbox scanning, real material regeneration, destructive profile/database actions, or worker-backed jobs unless the user explicitly asks for that behavior later.
- [ ] **QA-06**: Documentation is updated only where behavior or QA expectations changed; blind-auto-apply positioning remains deferred unless separately requested.

## Existing Foundations

These are already validated foundations that v1.2 may rely on but does not re-implement:

- [x] Discovery, enrichment, scoring, tailoring, cover, apply, and projection-backed read-model pipeline exists.
- [x] v1.0 grounded resume tailoring delivered employer analysis, per-bullet provenance, granular controls, voice pass, canonical read model, generate-materials wiring, and inspector UI.
- [x] `ArtifactTailoringExplanation` exposes annotated changes, per-bullet provenance, keyword coverage, quality/judge data, adversarial review data, review feedback, and model metadata.
- [x] Jobs view has a row-click `JobDetailDrawer` backed by `useJobDetailQuery`.
- [x] Apply Review has queue selection, decision controls, resume PDF/text preview, cover-letter preview, and `ArtifactTailoringInspector`.
- [x] v1.1 shadcn/token migration through Phases 6-10 landed semantic tokens, shared primitives, layout chrome, Tabler target, status semantics, and route visual QA.

## Future Requirements

Deferred to a future release. Tracked but not in the current roadmap.

### Audit Surface Evolution

- **LEDGER-01**: Option 2 Evidence Ledger as an optional bulk comparison and audit export surface.
- **TIMELINE-01**: Option 3 Gate Timeline as an optional lifecycle/debug chronology.
- **PDFPIN-01**: Deep PDF coordinate annotation if text/provenance anchors prove insufficient.
- **ANNOTATE-01**: Reviewer comments or annotations attached to individual resume pins.
- **EXPORT-01**: Exportable audit packet for a selected application.

### Product Positioning

- **SAFETYDOC-01**: README/docs positioning that explains why JobHunter is safer than blind auto-apply tools.

### Visual System Evolution

- **THEME-01**: User-editable theme settings for color, radius, and typography.
- **VISUAL-01**: Dedicated visual-regression service such as Chromatic, Loki, Percy, or equivalent.
- **MOTION-01**: Motion and microinteraction system with reduced-motion criteria.

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Option 2 Evidence Ledger implementation | It was a comparison sketch; user chose Option 1. |
| Option 3 Gate Timeline implementation | It was a comparison sketch; user chose Option 1. |
| UI copy explaining why JobHunter is safer than blind auto-apply tools | User explicitly deferred this to README/docs positioning later. |
| Auto-apply, browser submission, mailbox scanning, real generated-material regeneration, destructive profile/database actions, or worker-backed jobs | Safety boundary; not part of audit UX milestone unless explicitly requested later. |
| Broad route redesign, landing page, marketing dashboard treatment, or information-architecture rewrite | The milestone updates two existing surfaces, not the whole product. |
| Scoring, tailoring, cover-letter, or worker policy redesign | The milestone displays and audits existing facts; policy changes need separate scope. |
| Hiding or suppressing missing audit data | This violates auditability and does not fix source-of-truth gaps. |
| Broad visual-system migration | v1.1 completed the visual migration; v1.2 only folds in narrow cleanup. |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| CLEAN-01 | Phase 12 | Complete |
| CLEAN-02 | Phase 12 | Complete |
| CLEAN-03 | Phase 12 | Complete |
| CLEAN-04 | Phase 12 | Complete |
| AUDIT-01 | Phase 13 | Complete |
| AUDIT-02 | Phase 13 | Complete |
| AUDIT-03 | Phase 13 | Complete |
| AUDIT-04 | Phase 13 | Complete |
| AUDIT-05 | Phase 13 | Complete |
| AUDIT-06 | Phase 13 | Complete |
| DRAWER-01 | Phase 14 | Complete |
| DRAWER-02 | Phase 14 | Complete |
| DRAWER-03 | Phase 14 | Complete |
| DRAWER-04 | Phase 14 | Complete |
| DRAWER-05 | Phase 14 | Complete |
| DRAWER-06 | Phase 14 | Complete |
| REVIEW-01 | Phase 15 | Planned |
| REVIEW-02 | Phase 15 | Planned |
| REVIEW-03 | Phase 15 | Planned |
| REVIEW-04 | Phase 15 | Planned |
| REVIEW-05 | Phase 15 | Planned |
| REVIEW-06 | Phase 15 | Planned |
| REVIEW-07 | Phase 15 | Planned |
| REVIEW-08 | Phase 15 | Planned |
| QA-01 | Phase 16 | Planned |
| QA-02 | Phase 16 | Planned |
| QA-03 | Phase 16 | Planned |
| QA-04 | Phase 16 | Planned |
| QA-05 | Phase 16 | Planned |
| QA-06 | Phase 16 | Planned |

**Coverage:**

- v1.2 requirements: 30 total
- Complete: 16
- Mapped to phases: 30
- Unmapped: 0

---
*Requirements defined: 2026-06-11*
*Last updated: 2026-06-11 after Phase 14 completion*
