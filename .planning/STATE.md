---
gsd_state_version: 1.0
milestone: v1.2
milestone_name: Apply Review Audit UX - Drawer + Resume Pins
status: complete
last_updated: "2026-06-12T17:19:20.000Z"
last_activity: 2026-06-12
progress:
  total_phases: 5
  completed_phases: 5
  total_plans: 13
  completed_plans: 13
  percent: 100
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-11)

**Core value:** A user can trust every line of a tailored resume because each bullet traces visibly to a real profile fact and a specific job requirement, with the reasoning and transform rule available for review.
**Current focus:** Milestone v1.2 complete; PR review/merge remains. Post-completion QA corrections: `pnpm dev:start` prints observed service bindings, Jobs visible row clicks open the job overlay, the Jobs overlay is now an almost full-screen audit workspace, fit-score badges use a numeric 0 red / 5 gray / 10 green color scale, Apply Review ready/ok status badges use visible success-green background styling, Apply Review falls back to a line-by-line rendered-resume audit when generation provenance is missing, selecting a resume audit line highlights the matching rendered resume text line while preserving the faithful PDF below, the fallback rendered-resume line surface now looks like a PDF-style document page rather than a debug list, Apply Review now sources claim attribution from the tailored text artifact while keeping the PDF artifact for visual rendering, source-backed rendered resume lines are no longer mislabeled as claim risk when only audit metadata gaps exist, section-level fallback lineage is labeled as a source span with a source pointer instead of raw original bullet text, the right audit rail scrolls to the selected rendered line, and the worker material lifecycle now preserves accepted artifacts during refresh while regenerating complete current-generation resume/cover/PDF materials for every score-qualified non-blocked job.

## Current Position

Phase: v1.2 complete
Plan: All milestone plans complete
Status: Complete
Last activity: 2026-06-12 - Post-completion Apply Review source-span lineage correction completed

## Active Milestone Summary

Milestone v1.2 implements Sketch 002 Option 1: Drawer + Resume Pins. The milestone updates two existing surfaces:

| Surface | Owns |
|---------|------|
| Jobs row-click drawer (`JobDetailDrawer`) | Why ranked, readiness, hard blockers, eligibility concerns, and handoff to Apply Review |
| Apply Review rendered resume/material surface | Source-to-artifact changes, grounding, claim risk, readiness agreement, and reviewer inspection before approval |

Cross-surface invariant: readiness and eligibility/blocker facts must come from one shared API/read contract so the product cannot show contradictory facts for the same job.

The leftover v1.1 cleanup is folded into v1.2 as a small early housekeeping slice. It covers stale verification command normalization, dependency/config audits, optional obsolete `lucide-react` cleanup only if import proof allows it, and narrow docs/config updates for final shadcn token, Tabler icon, font, and QA expectations.

Explicitly not in scope:

- Option 2 Evidence Ledger and Option 3 Gate Timeline.
- Blind-auto-apply safety positioning in UI; README/docs positioning stays deferred.
- Auto-apply, browser submission, mailbox scanning, real generated-material regeneration, destructive profile/database actions, or worker-backed jobs unless explicitly requested later.
- Broad route redesign, scoring/tailoring policy redesign, worker automation expansion, marketing dashboard treatment, or landing-page work.
- Hiding/suppressing missing audit data as a substitute for fixing the source of truth.

## Roadmap

| Phase | Name | Status | Requirements |
|-------|------|--------|--------------|
| 12 | Folded Cleanup + Verification Baseline | Complete | CLEAN-01..CLEAN-04 |
| 13 | Shared Apply Audit Contract | Complete | AUDIT-01..AUDIT-06 |
| 14 | Jobs Drawer Audit Triage | Complete | DRAWER-01..DRAWER-06 |
| 15 | Apply Review Resume Pins | Complete | REVIEW-01..REVIEW-08 |
| 16 | Product-Path QA + Documentation | Complete | QA-01..QA-06 |

Next command: PR review/merge workflow.

## Research Summary

Research completed on 2026-06-11 in `.planning/research/`.

Key findings:

- Use the existing React/Vite/Tailwind/TanStack/shadcn stack; no new runtime dependency is recommended for the MVP.
- A shared apply audit contract must precede UI work.
- Resume pins should be derived from canonical artifact audit data, starting with `bulletProvenance` and `annotatedChanges`.
- Jobs drawer and Apply Review have separate responsibilities; ranking belongs in Jobs, generated-material proof belongs in Apply Review.
- QA must use synthetic/seeded data and must not trigger apply submission or worker-backed automation.

## Completed Phase Evidence

### Phase 12 - Folded Cleanup + Verification Baseline

- Removed unused `lucide-react` dependency after source import audit proved zero `apps/web/src` imports.
- Updated current-state codebase maps to describe Tailwind 4 CSS-first styling through `globals.css`, `tokens.css`, and `components.json`.
- Updated `docs/frontend-target.md` icon guidance to use `@tabler/icons-react` and reject new `lucide-react` imports.
- Verified with dependency/import audits, stale Tailwind config scans, strict legacy token scan, `corepack pnpm web:check`, `corepack pnpm web:build`, and `git diff --check`.

### Phase 13 - Shared Apply Audit Contract

- Added the shared `ApplyAudit` contract to `@jobhunter/contracts` and exposed it on both `ApplyReviewQueueItem` and `JobDetail`.
- Added API/read-model derivation through `apps/api/src/apply-audit.ts`, sourced from application target, material availability, current stage state/error, latest apply run, score eligibility, and review evidence availability.
- Updated Apply Review to consume `item.applyAudit` for queue tags, status counts, selected header status, summary copy, and compact missing/blocker/eligibility/source facts.
- Verified with `corepack pnpm api:check`, targeted API tests, `corepack pnpm web:check`, targeted web tests, `corepack pnpm web:build`, `git diff --check`, and in-app browser QA on `/apply-review`.

### Phase 14 - Jobs Drawer Audit Triage

- Added a top-of-drawer audit triage section to `JobDetailDrawer` that answers why a job ranked where it did and whether it is ready for apply review.
- Rendered rank evidence from existing score read-model fields and readiness/blocker/eligibility facts from the shared `applyAudit` contract only.
- Added a non-mutating `/apply-review` handoff for generated-material proof instead of duplicating the full resume audit surface in the Jobs drawer.
- Extended Jobs drawer regression tests and local QA docs for the new audit smoke path.
- Verified with `corepack pnpm web:check`, targeted Jobs drawer tests, `corepack pnpm web:build`, `git diff --check`, and product-path browser QA from `/jobs` row activation.

### Phase 15 - Apply Review Resume Pins

- Added `ResumeAuditPins` as a context-owned material audit component backed by artifact detail read models.
- Reworked Apply Review's Application Materials pane so the rendered resume appears first, with claim pins beside it on wider containers and below it on narrow containers.
- Pin detail exposes source text, tailored text, transform, controls, evidence IDs, requirement IDs, matched signals, rationale, and grounding/risk/lifecycle facts.
- Preserved the full tailoring inspector below the resume-centered pin surface.
- Updated Apply Review tests and local QA docs for populated provenance and no-provenance states.
- Verified with `corepack pnpm web:check`, targeted Apply Review tests, `corepack pnpm web:build`, `git diff --check`, and product-path browser QA on `/apply-review`.

### Phase 16 - Product-Path QA + Documentation

- Ran API and web verification commands for the changed surfaces.
- Re-verified the Jobs drawer product path from `/jobs` row activation.
- Re-verified the Apply Review product path from `/apply-review`.
- Confirmed docs/checklists cover Jobs drawer audit triage and Apply Review resume pins.
- Recorded final milestone acceptance evidence.
- Follow-up correction: detached `pnpm dev:start` now reports observed API/web/Temporal bindings, including the actual Vite web URL when the requested port is occupied and Vite binds a higher port.
- Follow-up correction: Jobs fit-score badges now use the numeric score as the color source of truth: 10 maps to visible green, 5 maps to neutral gray, and 0 maps to visible red, with intermediate scores moving toward the nearest endpoint.
- Follow-up correction: Apply Review ready/ok badges and success facts now render in the success-green family instead of info/blue or weak neutral styling.
- Follow-up correction: Apply Review no longer collapses to an empty provenance state when rendered resume text exists; the Application Materials pane now shows a line-by-line rendered-resume audit fallback and lays the audit inspector beside the PDF on wide screens.
- Follow-up correction: Apply Review now keeps the audit rail and rendered-resume text selection synchronized so selecting a no-provenance audit row highlights the exact rendered text line, with the faithful PDF retained below for visual verification.
- Follow-up correction: Apply Review rendered-resume fallback now uses a PDF-style page treatment with hidden debug labels, preserved blank lines, section/bullet styling, and selectable rendered text so the audit surface visually matches the generated resume instead of a line-debug table.
- Follow-up correction: Apply Review now uses a separate tailored-resume text artifact id for source attribution, claim pins, and the tailoring inspector while keeping the resume PDF artifact id for faithful visual rendering, so PDF shell metadata no longer causes false missing-source states.
- Follow-up correction: Apply Review audit rows now come from the rendered resume lines when rendered text exists, attach matching bullet/change provenance per line, keep audit metadata gaps separate from actual claim-risk findings, show source-backed/grounded status for backed lines, and scroll the right audit rail to the selected rendered line.
- Follow-up correction: Apply Review now distinguishes canonical bullet provenance from coarse annotated-change fallback lineage; fallback rows show a source pointer and `source span` precision with the broader source span collapsed, instead of displaying a list of original bullets as if it were exact per-bullet lineage.
- Follow-up correction: Shared success badges now use a visibly green background fill, border, and foreground using `oklab` color mixing so the `materials ready` header badge reads green in the browser.
- Follow-up correction: Jobs table visible row content now opens the job overlay while checkbox hitboxes remain selection-only; verified by targeted grid/Jobs tests and live `/jobs` browser QA.
- Follow-up correction: Jobs row-click overlay now opens as an almost full-screen audit workspace with a wide two-column detail grid so ranking, readiness, diagnostics, artifacts, outcomes, scoring, description, and audit history have usable room.
- Follow-up correction: tailoring and cover lifecycle state now stays aligned with approved current-generation artifacts: rejected refreshes no longer hide accepted materials, orphaned stages recover from approved artifacts, re-tailor defaults preserve existing artifacts until replacement approval, new resume generations reset cover readiness to pending, and target-job-only technologies are explicitly context rather than candidate evidence in the generator prompt.
- Live material-generation QA: after targeted repairs and reruns, all 49 score-qualified non-blocked jobs have complete approved current materials (`tailored_resume`, `resume_pdf`, `cover_letter`, `cover_letter_pdf`); the remaining 4 score-qualified incomplete jobs are blocked by score eligibility compensation blockers.
- Verified safety boundaries: no auto-apply, browser submission, mailbox scanning, destructive profile/database action, or application submission. Worker-backed material regeneration was run only for the requested score-qualified landscape repair.

## Prior Milestone Verification

Milestone v1.0 was verified on 2026-06-09. All five phases plus cross-phase integration returned PASS. The durable summary is `.planning/MILESTONE-ACCEPTANCE.md`.

Milestone v1.1 completed Phases 6-10 and landed semantic tokens, shared primitives, layout chrome, Tabler target, status semantics, and route visual QA via PRs #151-#155. The planned Phase 11 cleanup did not start and is now folded into v1.2 Phase 12.

## Accumulated Context

### Current Decisions

- Choose Sketch 002 Option 1: Drawer + Resume Pins for implementation.
- Define "job overlay" as the Jobs row-click drawer (`JobDetailDrawer`), not an Apply Review queue panel.
- Keep Apply Review centered on the rendered resume/material, with row/claim pins for evidence inspection.
- Share readiness and eligibility facts across Jobs drawer and Apply Review from one contract/source of truth.
- Fold the leftover v1.1 cleanup into v1.2 as housekeeping, not as the core product outcome.
- Defer blind-auto-apply safety positioning to README/docs rather than the v1.2 UI scope.

### Constraints And Concerns

- Auditability risk: the UI must not hide missing or embarrassing audit data; missing sources must be fixed at the owning layer.
- Scope risk: ranking explanation belongs in the Jobs row-click drawer, while generated-material proof belongs in Apply Review.
- Pin risk: PDF coordinates may be brittle; start from generated text/provenance anchors and validate visual placement during Phase 15.
- QA risk: browser proof must use synthetic/seeded data and must not run auto-apply, browser submission, mailbox scanning, real material generation, destructive profile/database actions, or worker-backed jobs.
- Cleanup risk: folded v1.1 cleanup should close stale dependency/config/docs items without re-opening broad visual-system migration.

## Deferred Items

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Audit UX | Option 2 Evidence Ledger | Future milestone | 2026-06-11 |
| Audit UX | Option 3 Gate Timeline | Future milestone | 2026-06-11 |
| Audit UX | Deep PDF coordinate annotation beyond stable provenance/text anchors | Future milestone unless Phase 15 proves required | 2026-06-11 |
| Product positioning | README/docs copy explaining why JobHunter is safer than blind auto-apply tools | Future docs update | 2026-06-11 |
| Visual system | User-editable theme customization | Future milestone | 2026-06-09 |
| Visual system | Dedicated visual regression service such as Chromatic/Loki/Percy | Future milestone | 2026-06-09 |
| Motion | Motion and microinteraction system | Future milestone | 2026-06-09 |

## Session Continuity

Last session: 2026-06-11
Stopped at: v1.2 complete
Latest phase completed: Phase 16 - Product-Path QA + Documentation
Resume file: None
