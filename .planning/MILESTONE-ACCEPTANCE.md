# Milestone v1.0 — Grounded Resume Tailoring — Acceptance

**Status:** COMPLETE (verified 2026-06-09)
**Verified against:** merged `main` @ `e36ffb1`
**Method:** goal-backward verification — each ROADMAP success criterion checked against the actual merged code + passing tests (not PR titles), per phase, plus a cross-phase integration audit. Per-phase detail in `phases/0N-*/VERIFICATION.md`.

## Result: 5/5 phases PASS · 26/26 requirements wired

| Phase | Requirements | PR(s) | Verdict | Report |
|-------|--------------|-------|---------|--------|
| 1 · Canonical Employer Analysis | ANALYSIS-01..06 | #141, #146, #147, #148 | PASS (4/4) | `phases/01-canonical-employer-analysis/VERIFICATION.md` |
| 2 · Per-Bullet Provenance + Controls | GROUND-01..05, CONTROL-01..03 | #142 | PASS (5/5) | `phases/02-per-bullet-provenance-controls/VERIFICATION.md` |
| 3 · Voice Pass + Final Audit | GROUND-06, VOICE-01..03 | #143 | PASS (4/4) | `phases/03-voice-pass-final-audit/VERIFICATION.md` |
| 4 · Read-Model Cleanup (rip-and-replace) | AUDIT-01..02 | #144 | PASS (3/3) | `phases/04-read-model-cleanup/VERIFICATION.md` |
| 5 · Generate-Materials + Inspector UI | INSPECT-01..06 | #145 | PASS (4/4) | `phases/05-generate-materials-inspector-ui/VERIFICATION.md` |

**Cross-phase integration: PASS** — all five seams (analysis → provenance → voice → audit → read-model → inspector) WIRED; every one of the 26 v1 requirements has a verified cross-phase touchpoint.

## Process note

These phases were implemented through the repository PR workflow (worktree → review → QA → merge),
**not** the GSD `/gsd-plan-phase` + `/gsd-execute-phase` loop. As a result no GSD `PLAN.md` artifacts
exist; the work was verified retroactively (this document + the per-phase `VERIFICATION.md`).
`STATE.md` / `ROADMAP.md` / `REQUIREMENTS.md` were reconciled to reflect reality on 2026-06-09.

## Residual (non-blocking)

- **LOW** — stale `generate_materials` branch in `apps/web/.../local-actions.ts` (dead path; the route uses `run_stage`).
- **LOW** — inspector diff "original bullet" sourced from `annotatedChanges`, not a canonical provenance column.
- **LOW (env)** — Phase 5 live Playwright E2E needs a clean-environment run (port-reuse artifact, not a code defect).
- **Out of scope** — 3 pre-existing failing tests (enrichment staleness ×2, materials suppression) unrelated to this milestone.
- **Skipped by user** — live matched-job happy-path demo (the code path is already verified).

---

# Milestone v1.2 — Apply Review Audit UX - Drawer + Resume Pins — Acceptance

**Status:** COMPLETE (verified 2026-06-11)
**Verified against:** branch `worktree/c151` through the Phase 16 documentation commit
**Method:** goal-backward verification against `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, targeted automated tests, and browser product-path QA.

## Result: 5/5 phases PASS · 30/30 requirements wired

| Phase | Requirements | Verdict | Report |
|-------|--------------|---------|--------|
| 12 · Folded Cleanup + Verification Baseline | CLEAN-01..04 | PASS | `phases/12-folded-cleanup-verification-baseline/12-VERIFICATION.md` |
| 13 · Shared Apply Audit Contract | AUDIT-01..06 | PASS | `phases/13-shared-apply-audit-contract/13-VERIFICATION.md` |
| 14 · Jobs Drawer Audit Triage | DRAWER-01..06 | PASS | `phases/14-jobs-drawer-audit-triage/14-VERIFICATION.md` |
| 15 · Apply Review Resume Pins | REVIEW-01..08 | PASS | `phases/15-apply-review-resume-pins/15-VERIFICATION.md` |
| 16 · Product-Path QA + Documentation | QA-01..06 | PASS | `phases/16-product-path-qa-documentation/16-VERIFICATION.md` |

## Verification Summary

- `corepack pnpm api:check` passed.
- `corepack pnpm --filter @jobhunter/api test -- apply-audit application-feedback server` passed, 11 files / 207 tests.
- `corepack pnpm web:check` passed.
- `corepack pnpm --filter @jobhunter/web test src/views/apply-review/ApplyReviewView.test.tsx src/views/jobs/JobDetailDrawer.test.tsx src/views/jobs/JobOverview.test.tsx` passed, 3 files / 20 tests.
- `corepack pnpm web:build` passed with the existing Vite large-chunk warning.
- `git diff --check` passed.
- Browser QA passed for `/jobs` row activation into the audit triage drawer.
- Browser QA passed for `/apply-review` rendered-resume-first review surface and explicit no-provenance state.
- Post-completion QA correction: `pnpm dev:start` now prints observed local bindings after launch, including the actual Vite web URL when port fallback occurs; verified by `corepack pnpm --dir apps/api exec vitest run test/dev-launcher-contract.test.ts`, `bash -n scripts/dev`, `git diff --check`, and a live `pnpm dev:start web` smoke.
- Post-completion QA correction: Jobs fit-score badges now use the numeric score as the color source of truth: 10 maps to visible green, 5 maps to neutral gray, and 0 maps to visible red, with intermediate scores moving toward the nearest endpoint; verified by targeted ScoreBadge regression coverage.
- Post-completion QA correction: Apply Review ready/ok status badges and success facts now use visible success-green styling rather than blue/info or weak neutral styling; verified by targeted Apply Review and Jobs drawer regression coverage.
- Post-completion QA correction: Apply Review now falls back from missing artifact provenance to a line-by-line rendered-resume audit, preserving reviewer inspection instead of showing an empty pin state; verified by `corepack pnpm --filter @jobhunter/web test src/views/apply-review/ApplyReviewView.test.tsx`, `corepack pnpm web:check`, and `git diff --check`.
- Post-completion QA correction: Apply Review now synchronizes the line-by-line audit rail with a highlightable rendered-resume text surface, so selecting a no-provenance audit row highlights the matching resume line while the faithful PDF remains below for visual verification; verified by `corepack pnpm --filter @jobhunter/web test src/views/apply-review/ApplyReviewView.test.tsx`, `corepack pnpm web:check`, `corepack pnpm web:build`, `git diff --check`, and live browser QA on `/apply-review`.
- Post-completion QA correction: Shared success badges now use a visibly green `oklab`-mixed background, border, and foreground so the Apply Review `materials ready` badge does not render as a weak non-green tint; verified by `corepack pnpm --filter @jobhunter/web test src/styles/token-contract.test.ts src/views/apply-review/ApplyReviewView.test.tsx`, `corepack pnpm web:check`, `git diff --check`, and live computed-style QA on `/apply-review`.
- Post-completion QA correction: Jobs table visible row content now opens the job overlay while checkbox hitboxes remain selection-only; verified by `corepack pnpm --filter @jobhunter/web test src/shared/ui/filterable-data-grid.test.tsx src/views/jobs/JobsTable.test.tsx src/views/jobs/JobDetailDrawer.test.tsx`, `corepack pnpm web:check`, `git diff --check`, and live browser QA on `/jobs`.
- Post-completion QA correction: Jobs row-click overlay now opens as an almost full-screen audit workspace with a wide detail grid instead of a narrow side drawer; verified by targeted Jobs drawer regression coverage and live browser QA on `/jobs/<job id>`.
- Post-completion QA correction: Material lifecycle hardening now prevents failed refreshes from hiding accepted artifacts, recovers orphaned stages from approved artifacts, preserves accepted artifacts by default during re-tailor, invalidates stale cover readiness after a new resume generation, and makes target-job-only technologies context rather than evidence in the tailoring prompt; verified by targeted Python and API regression suites plus live worker reruns.
- Live material-generation QA: all 49 score-qualified non-blocked jobs now have approved current-generation resume text, resume PDF, cover letter, and cover PDF; the remaining 4 score-qualified incomplete jobs are blocked by score eligibility compensation blockers.

## Residual

- **Non-blocking:** Browser QA with local data showed the no-provenance state for the selected artifact; populated source-to-tailored pins, grounded/risky claim labels, unsupported claims, missing required evidence, and residual warning lifecycle are covered by synthetic Apply Review tests.
- **Existing warning:** `corepack pnpm web:build` still emits the existing large chunk warning.
- **Deferred:** Option 2 Evidence Ledger, Option 3 Gate Timeline, true PDF text-layer coordinate annotations, reviewer comments on pins, audit packet export, and blind-auto-apply positioning copy.
