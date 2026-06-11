# Roadmap: v1.2 Apply Review Audit UX - Drawer + Resume Pins

## v1.2 Apply Review Audit UX - Drawer + Resume Pins

## Overview

Milestone v1.2 implements Sketch 002 Option 1: Drawer + Resume Pins. The goal is to make the existing Jobs row-click drawer and the Apply Review rendered-resume surface explain the audit trail clearly enough that a technical job seeker can understand why a job ranked highly, whether it is ready for apply review, what hard blockers or eligibility concerns exist, what changed from source profile/resume into the tailored artifact, and whether generated claims are grounded or risky.

This is not a broad redesign. The Jobs overlay means the existing Jobs view popup/drawer opened after clicking a job row (`JobDetailDrawer`). The Jobs drawer owns ranking, readiness, blockers, and eligibility concerns. Apply Review owns generated-material inspection, centered on the rendered resume with source-backed pins. Both surfaces must consume the same readiness/blocker facts from a shared API/read contract so the product cannot say "ready" in one place and "not ready" in another for the same job.

The milestone starts with the leftover v1.1 cleanup folded in as a narrow housekeeping phase. Then it builds the shared contract, updates the Jobs drawer, implements Apply Review resume pins, and closes with synthetic product-path QA and documentation. Option 2 Evidence Ledger, Option 3 Gate Timeline, and blind-auto-apply safety positioning are deferred.

## Phases

**Phase Numbering:**

- Milestone v1.0 completed Phases 1-5.
- Milestone v1.1 completed Phases 6-10.
- The planned v1.1 Phase 11 cleanup is folded into v1.2 as Phase 12.
- This milestone continues numbering at Phase 12.
- Integer phases are planned milestone work.
- Decimal phases are reserved for urgent insertions.

- [x] **Phase 12: Folded Cleanup + Verification Baseline** - Close narrow v1.1 cleanup residue before feature work: stale verification commands, dependency/config audits, optional unused icon dependency removal, and docs/config normalization.
- [x] **Phase 13: Shared Apply Audit Contract** - Add one readiness/blocker/eligibility contract served by the API/read model and consumed by both Jobs drawer and Apply Review.
- [x] **Phase 14: Jobs Drawer Audit Triage** - Reframe the Jobs row-click drawer around why ranked, readiness, blockers, eligibility concerns, and handoff to Apply Review.
- [ ] **Phase 15: Apply Review Resume Pins** - Make the rendered resume/material central and add provenance-backed pins with source-to-tailored change, grounding, risk, and action detail.
- [ ] **Phase 16: Product-Path QA + Documentation** - Verify both surfaces end to end with synthetic data, update docs/checklists, and audit milestone acceptance.

## Phase Details

### Phase 12: Folded Cleanup + Verification Baseline

**Goal:** The repo has a clean baseline for v1.2 feature work, with leftover v1.1 cleanup closed without reopening the visual-system migration.

**Depends on:** v1.1 Phases 6-10 complete and v1.2 milestone scope accepted.

**Requirements:** CLEAN-01, CLEAN-02, CLEAN-03, CLEAN-04

**Success Criteria** (what must be TRUE):

1. Stale verification commands and docs no longer reference removed Tailwind config assumptions such as `apps/web/tailwind.config.ts`.
2. Import/dependency/config audits prove whether `lucide-react` and other visual-migration remnants are still required before any removal.
3. Docs/config owners reflect final shadcn semantic token, Tabler icon, font, and QA expectations.
4. Legacy token references such as `--paper`, `--ink`, `--rule`, `bg-paper`, `text-ink`, `border-rule`, and `ring-info` remain absent from production styling/config except intentional historical notes.
5. The phase does not change product layout, route behavior, scoring policy, tailoring policy, or worker behavior.

**Verification:**

- `rg "apps/web/tailwind.config.ts|tailwind.config" README.md docs AGENTS.md .planning apps/web`
- `rg "lucide-react|@tabler/icons-react" apps/web/src apps/web/package.json pnpm-lock.yaml`
- Legacy token grep over production styling and web source.
- `pnpm web:check`
- `pnpm web:build`
- `pnpm --filter @jobhunter/web test` if touched code warrants it.
- `git diff --check`

**Plans:** 2/2 plans executed.

Plans:

- [x] 12-01-PLAN.md - Dependency and config cleanup.
- [x] 12-02-PLAN.md - Documentation and baseline verification.

### Phase 13: Shared Apply Audit Contract

**Goal:** Jobs drawer and Apply Review consume the same readiness, blocker, and eligibility facts from one source of truth.

**Depends on:** Phase 12.

**Requirements:** AUDIT-01, AUDIT-02, AUDIT-03, AUDIT-04, AUDIT-05, AUDIT-06

**Success Criteria** (what must be TRUE):

1. `@jobhunter/contracts` defines a shared apply-audit/readiness DTO that includes state, label, summary, missing prerequisites, hard blockers, eligibility concerns, lifecycle/source metadata, and whether review evidence remains available.
2. API/read-model code derives the DTO from canonical local sources: application URL, material availability, current stage/state/error, latest apply run, score eligibility, and material validation/audit data where present.
3. `JobDetail` and `ApplyReviewQueueItem` expose the same shared DTO for the same job.
4. Apply Review no longer owns source-of-truth readiness logic in a view-local status function; view helpers are formatting-only.
5. Missing source data renders explicit inspectable states rather than blank or hidden UI.
6. Tests cover ready, preparing, missing apply link, missing resume/PDF, blocked/failed/stale, failed apply run, and missing-source cases.

**Verification:**

- `pnpm api:test` targeted to read-model/apply-review queue tests.
- `pnpm api:check`
- `pnpm web:check`
- `pnpm --filter @jobhunter/web test` targeted to readiness/blocker display.
- Contract/type tests if DTO changes require them.
- `git diff --check`

**Plans:** 2/2 plans executed.

Plans:

- [x] 13-01-PLAN.md - Contract and API derivation.
- [x] 13-02-PLAN.md - Apply Review consumption.

### Phase 14: Jobs Drawer Audit Triage

**Goal:** The existing Jobs row-click drawer immediately answers why the job was ranked the way it was and whether it is ready for apply review.

**Depends on:** Phase 13.

**Requirements:** DRAWER-01, DRAWER-02, DRAWER-03, DRAWER-04, DRAWER-05, DRAWER-06

**Success Criteria** (what must be TRUE):

1. Opening a job row in the Jobs view shows a drawer top section that summarizes ranking, readiness, blockers, and eligibility without requiring the user to hunt through generic diagnostics.
2. Rank explanation includes fit score, score band/confidence where available, matched/missing/transferable signals, keywords, score reasoning/trace where available, and eligibility status/concerns.
3. Readiness and blocker display uses the Phase 13 shared apply audit contract.
4. The drawer clearly separates job-fit evidence from generated-material proof and links/hands off to Apply Review for resume/material inspection.
5. Existing drawer behaviors remain intact: close/escape, job actions, retry affordances, artifact links, apply history, outcome panel, score correction, description, and audit history.
6. The drawer remains responsive, keyboard accessible, dense, and readable across light/dark themes and density modes.

**Verification:**

- `pnpm web:check`
- `pnpm web:build`
- `pnpm --filter @jobhunter/web test` targeted to Jobs drawer components.
- Storybook/a11y checks if new extracted drawer components gain stories.
- Browser QA on `/jobs`: open row-click drawer and prove rank/readiness/blocker/eligibility stories with synthetic or seeded data.
- `git diff --check`

**Plans:** 2/2 plans executed.

Plans:

- [x] 14-01-PLAN.md - Drawer audit triage component.
- [x] 14-02-PLAN.md - Regression coverage and documentation.

### Phase 15: Apply Review Resume Pins

**Goal:** Apply Review centers the actual rendered resume/material and makes source-to-tailored proof inspectable at the claim/row level.

**Depends on:** Phase 13 and Phase 14.

**Requirements:** REVIEW-01, REVIEW-02, REVIEW-03, REVIEW-04, REVIEW-05, REVIEW-06, REVIEW-07, REVIEW-08

**Success Criteria** (what must be TRUE):

1. Apply Review layout centers the rendered resume/material as the main review object while preserving queue selection, status, and decision controls.
2. Resume pins/markers are derived from canonical artifact audit data, starting with `bulletProvenance` and `annotatedChanges`.
3. Selecting a pin opens detail with source profile/resume text, tailored artifact text, transform/change type, governing controls, requirement IDs, evidence IDs, matched keywords, and rationale where recorded.
4. Pin detail displays grounding/risk status from quality, judge, adversarial review, coverage, and review-feedback signals where available.
5. Honest lifecycle and missing-source states remain visible: repair attempted, accepted with residual warnings, skipped audit, unsupported claim, missing required evidence, no source recorded, no provenance recorded, and PDF/text fallback.
6. Apply Review readiness/header and decision controls consume the shared apply audit contract and match the Jobs drawer facts.
7. Pin interactions are keyboard accessible, stable in layout, and usable across supported viewport sizes, light/dark themes, and density modes.

**Verification:**

- `pnpm web:check`
- `pnpm web:build`
- `pnpm --filter @jobhunter/web test` targeted to pin model/components and Apply Review layout.
- `pnpm --filter @jobhunter/web test-d` if pin/component public types warrant it.
- Storybook/a11y checks if new pin inspector or audit components gain stories.
- Browser QA on `/apply-review`: ready job, blocker job, grounded claim pin, risky/unsupported claim pin, missing-source/no-provenance state, PDF/text fallback.
- `git diff --check`

**Plans:** Create with `$gsd-plan-phase 15`.

### Phase 16: Product-Path QA + Documentation

**Goal:** The milestone is verified from the user's product path and documented without exposing sensitive local data or triggering application submission flows.

**Depends on:** Phase 15.

**Requirements:** QA-01, QA-02, QA-03, QA-04, QA-05, QA-06

**Success Criteria** (what must be TRUE):

1. API and web verification commands pass for the changed surfaces.
2. Browser QA proves Jobs drawer stories: why ranked, readiness, blockers, eligibility concerns, and drawer-to-review handoff.
3. Browser QA proves Apply Review stories: readiness agreement, resume-centered review, pin selection, source-to-tailored detail, grounded claim, risky/unsupported claim, missing-source state, and no-provenance fallback.
4. All QA data, screenshots, stories, fixtures, and docs use synthetic or seeded data only.
5. QA does not run auto-apply, browser submission, mailbox scanning, real material regeneration, destructive profile/database actions, or worker-backed jobs unless the user explicitly asks later.
6. Documentation updates are narrow and limited to changed behavior or QA expectations; blind-auto-apply safety positioning remains deferred.
7. Milestone acceptance is audited against `.planning/REQUIREMENTS.md`, this roadmap, and product-path evidence.

**Verification:**

- `pnpm api:test`
- `pnpm api:check`
- `pnpm web:check`
- `pnpm web:build`
- `pnpm --filter @jobhunter/web test`
- `pnpm --filter @jobhunter/web test-d` when type-level tests are affected.
- Storybook/a11y checks for changed stories/components.
- Targeted Playwright or Browser QA with synthetic fixtures.
- `git diff --check`
- `$gsd-audit-milestone` or equivalent final milestone audit before completion.

**Plans:** Create with `$gsd-plan-phase 16`.

## Progress

**Execution Order:**
Phases execute in numeric order: 12 -> 13 -> 14 -> 15 -> 16

**Milestone Status:** Phase 14 complete; next step is `$gsd-plan-phase 15`.
