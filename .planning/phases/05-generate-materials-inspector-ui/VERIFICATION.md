---
phase: 05-generate-materials-inspector-ui
verified: 2026-06-09T17:20:30Z
status: human_needed
score: 4/4 success criteria verified (1 with a WARNING — live E2E run blocked by verification-environment, not by the shipped code)
mode: post-hoc reconciliation (work merged outside the GSD loop; PR #145 @ commit a229b13, verified against merged main @ e36ffb1)
requirements: [INSPECT-01, INSPECT-02, INSPECT-03, INSPECT-04, INSPECT-05, INSPECT-06]
human_verification:
  - test: "Run the materials E2E in a clean environment (no stale process on port 8767/5174). From repo root: `pnpm dev:stop` (or kill any API on 8767), then `pnpm --filter @jobhunter/web e2e materials.spec.ts`."
    expected: "Spec passes: seeded 'Director of Platform Engineering' (GitLab) row loads from the isolated E2E DB, the Generate-materials button is enabled, the dispatch returns 202 {ok,action:run_stage,status:queued}, and the injected ResumeApproved surfaces in Audit history."
    why_human: "Live E2E requires an isolated dev API on the seeded temp DB. In this ad-hoc reconcile run Playwright's `reuseExistingServer:!CI` reused a pre-existing API on port 8767 that served the real ~85-job workspace DB, so the seeded GitLab fixture row never loaded and the spec failed at the first page-load assertion — before any generate-materials code executed. This is a runner/port-isolation artifact, not a product or spec defect. A clean run is needed to fully close INSPECT-01's live-E2E leg."
---

# Phase 5: Generate-Materials Wiring + Inspector UI — Verification Report

**Phase Goal:** Fix the currently-broken per-job generate-materials path and expose employer analysis, per-bullet provenance, controls, and a diff view in an in-app inspector that renders every missing/covered/unmet state explicitly and never destroys the last accepted artifact.
**Verified:** 2026-06-09T17:20:30Z (post-hoc reconciliation; PR #145, merged main @ e36ffb1)
**Status:** human_needed (all 4 criteria met by code+test evidence; 1 WARNING requires a clean-environment live E2E run)

## Goal Achievement — Per-Criterion Verdicts

| # | Success criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Per-job materials generation invokable from product surface; route no longer returns 400; button enabled; E2E unskipped & passing | PASS (with WARNING on live-E2E run) | Route + button + tests verified; live E2E blocked by environment only |
| 2 | Inspector exposes employer "ideal candidate" analysis (requirements, priorities, reasoned keywords w/ evidence spans) AND per-bullet provenance (evidence × requirement × transform × control × rationale) in-app | PASS | `EmployerAnalysisPanel.tsx`, `BulletProvenanceList.tsx`, wired in `JobDetailDrawer.tsx` |
| 3 | Inspector shows diff (original → tailored) and renders missing/empty/covered/unmet explicitly, with per-state Storybook stories proving missing/embarrassing data is never masked | PASS | `BulletProvenanceList.tsx` diff + 2 stories files w/ per-state arms |
| 4 | Re-tailor/retry preserves last accepted artifact; failed refresh becomes audit history; never destroys current reviewable resume | PASS | optimistic patch scope + INSPECT-06 regression test + worker generation-versioning |

**Score:** 4/4 criteria substantively achieved.

---

### Criterion 1 — Generate-materials wiring (INSPECT-01) — PASS (WARNING on live E2E)

**Route (no unconditional 400).** `apps/api/src/server.ts:812-856` — the handler resolves the job, dispatches a canonical `run_stage` command over the material stages and returns `202` when queued (`server.ts:853`). The only `400` (`server.ts:833-836`) guards an empty stages array, which is unreachable in normal use because `GenerateMaterialsRequestSchema` defaults `stages` to `["tailor","cover"]` with `.min(1)` (`packages/contracts/src/schemas.ts:196-202`). There is no unconditional 400 stub.

**Route tests (passing).** `apps/api/test/server.test.ts:3566-3656` covers: 202 with explicit stages, 202 with default stages, 404 job-not-found, 503 worker-readiness. API suite: **201/201 passed** (`pnpm --filter @jobhunter/api test`).

**Button enabled.** `apps/web/src/contexts/materials/components/GenerateMaterialsButton.tsx:17-49` — enabled by default; `disabled` only on `mutation.isPending` or an explicit prop. Composed into `JobActions.tsx:39`. The dead `unsupportedPerJobMaterialAction` "not yet wired" stub was removed. Button tests (`GenerateMaterialsButton.test.tsx`): confirm-dispatch, decline-no-dispatch, disabled-prop — passing.

**Mutation.** `useGenerateMaterialsMutation.ts` is a real optimistic (queued) mutation via `createOptimisticMutation` with a real patcher (`patchStageRunning`), rollback on failure, and a settle-invalidation set. Hook tests pass.

**E2E spec — unskipped, correct assertions.** `apps/web/e2e/tests/materials.spec.ts` exists, is NOT `fixme`/`skip` (repo-wide grep for `fixme|test.skip|.skip(` in `e2e/tests/` returns nothing). It asserts button enabled, dispatch `202` with `{ok:true, action:"run_stage", status:"queued"}`, and the injected `ResumeApproved` surfacing in Audit history via the SSE→invalidation loop. Deterministic dispatch is wired via `JOBHUNTER_E2E_STUB_DISPATCH` (`apps/api/src/e2e-dispatch.ts`, `apps/api/src/main.ts:2,10,14`; config `playwright.config.ts:69`).

**WARNING — live E2E run blocked by environment (not by code).** My ad-hoc `pnpm --filter @jobhunter/web e2e materials.spec.ts` failed at the first assertion (`Director of Platform Engineering` row not visible). The failure page-snapshot shows ~85 real workspace jobs (BOLD, Fourthline, Glovo, Monzo…), NOT the seeded GitLab QA fixture — i.e. the running API was serving the production workspace DB, not the isolated E2E temp DB. Root cause: `playwright.config.ts:71` sets `reuseExistingServer: !CI`, so Playwright reused a pre-existing API already bound to port 8767 (serving the real DB) instead of launching the isolated E2E API on the seeded temp DB (`global-setup.ts` + qa-seed → temp `JOBHUNTER_E2E_DB_PATH`). The failure occurs before any generate-materials code runs and is a runner/port-isolation artifact. The spec, route, button, and dispatch are all verified by inspection + unit/integration tests. Severity: Low (verification-environment), routed to human for a clean-environment confirmation.

---

### Criterion 2 — Employer analysis + per-bullet provenance (INSPECT-02, INSPECT-03) — PASS

**Employer analysis component.** `EmployerAnalysisPanel.tsx` renders requirements with must/nice tier + priority weight + JD evidence span (`RequirementItem`, lines 18-40), reasoned keywords with quoted JD evidence span + rationale + requirement_ref + orphan flag (`KeywordItem`, lines 42-66), inferred seniority/agreement/ensemble-degradation/generation summary, and an ensemble audit trail (`SubAnalysisDetails`, lines 68-110).

**Per-bullet provenance component.** `BulletProvenanceList.tsx` `BulletProvenanceCard` (lines 95-136) renders all five dimensions: profile evidence (`evidenceIds`), serves requirement (`requirementIds`), transform (`transformType`), control (`control`), rationale, plus matched keywords and the diff.

**Wiring (Level 3) + data flow (Level 4).** Both are composed in-app in `JobDetailDrawer.tsx:129` (`<EmployerAnalysisPanel analysis={detail.employerAnalysis}/>`) and `:131` (`<ArtifactTailoringInspector artifactId={resumeArtifact.artifactId}/>`), and reused in `apply-review/ApplyReviewView.tsx:413`. Data is canonical, not hardcoded: `employerAnalysis` is parsed from the `job_employer_analysis` projection (`apps/api/src/read-model.ts:611`, projection SQL `projections.ts:729-750`); provenance comes from `bulletProvenanceForArtifact` reading `bullet_provenance_json` via real SQL (`read-model.ts:2123-2182`), and `tailoringExplanation` from `tailoringExplanationForArtifact` (`read-model.ts:1751,2039-2056`).

**Tests.** Component + a11y tests for both panels pass (part of 42/42 materials web tests; `EmployerAnalysisPanel.a11y.test.tsx`, `BulletProvenanceList.a11y.test.tsx` enforce zero critical/serious axe).

---

### Criterion 3 — Diff view + explicit states + per-state stories (INSPECT-04, INSPECT-05) — PASS

**Diff view.** `BulletProvenanceList.tsx` `BulletDiff` (lines 60-93) renders original profile bullet → tailored bullet side by side, sourced from `annotatedChanges` (`originalTextFor`, lines 20-31).

**Explicit honest states (never masked).** Missing original bullet → "Original profile bullet not recorded for this line." (line 72); drafted-from-evidence (empty array) → distinct explicit message (line 80); empty FK sets → "none recorded" (`TagList`, line 53); no rationale → "no rationale recorded" (line 130); no tailored text → explicit message (line 88); null employer analysis → "No employer analysis has been recorded…" (`EmployerAnalysisPanel.tsx:126-135`); empty requirements/keywords → explicit "No requirements/keywords were recorded" (lines 191, 204). No blank/fabricated fallbacks anywhere.

**Per-state Storybook stories.** `EmployerAnalysisPanel.stories.tsx`: Populated, Degraded, EmptyRequirementsAndKeywords, NotRecorded(null). `BulletProvenanceList.stories.tsx`: PopulatedWithDiff, MissingOriginalBullet (explicit not-recorded arm, `annotatedChanges:[]`), CoveredKeywords, Empty. These cover the missing/empty/covered discriminant arms proving embarrassing/missing data is shown, not hidden.

---

### Criterion 4 — Re-tailor preserves last accepted artifact (INSPECT-06) — PASS

**Optimistic patch is scope-limited.** `materialsJobDetailPatches.ts:21-31` `patchStageRunning` only flips the targeted material `stages[].state` to `"running"`; it never touches `artifacts` or `employerAnalysis`. The mutation's optimistic update applies only this patch (`useGenerateMaterialsMutation.ts:52-58`).

**Regression test asserts preservation.** `useGenerateMaterialsMutation.test.ts:63-77` — "preserves the last accepted artifact during the optimistic queued patch (INSPECT-06)": after the optimistic patch, `optimistic?.artifacts` deep-equals the original accepted artifacts (`resume-accepted`, status `active`). Passing.

**Backend supersede-on-approval.** The route comment (`server.ts:823-831`) documents — and the worker enforces via generation-versioning — that the prior accepted artifact is superseded only after a replacement is approved; a failed refresh remains audit history (`ResumeFailed`/`ResumeApproved` events drive the SSE invalidation router, surfaced in Audit history). The confirm dialog also states retention explicitly (`GenerateMaterialsButton.tsx:36-38`).

---

### Required Artifacts

| Artifact | Status | Notes |
|---|---|---|
| `apps/api/src/server.ts` generate-materials route | VERIFIED | 202 dispatch, no unconditional 400; tested 202/404/503 |
| `apps/api/src/e2e-dispatch.ts` + `main.ts` stub wiring | VERIFIED | Deterministic E2E dispatch gate |
| `apps/web/.../GenerateMaterialsButton.tsx` | VERIFIED | Enabled, confirm dialog, in-flight label; tested |
| `apps/web/.../useGenerateMaterialsMutation.ts` | VERIFIED | Real optimistic patch + rollback + settle invalidation |
| `apps/web/.../EmployerAnalysisPanel.tsx` | VERIFIED | Wired in drawer; canonical data |
| `apps/web/.../BulletProvenanceList.tsx` | VERIFIED | All 5 dims + diff + honest states |
| `apps/web/.../ArtifactTailoringInspector.tsx` | VERIFIED | Fetches artifact detail; reused in apply-review |
| `apps/web/e2e/tests/materials.spec.ts` | VERIFIED (unskipped) | Live run blocked by env (WARNING) |
| Storybook per-state stories (both panels) | VERIFIED | Per-state/per-arm coverage |

### Data-Flow Trace (Level 4)

| Artifact | Data variable | Source | Real data | Status |
|---|---|---|---|---|
| EmployerAnalysisPanel | `detail.employerAnalysis` | `read-model.ts:611` ← `job_employer_analysis` projection | Yes (SQL) | FLOWING |
| BulletProvenanceList | `bulletProvenance` | `read-model.ts:2123` ← `bullet_provenance_json` | Yes (SQL) | FLOWING |
| ArtifactTailoringInspector | `tailoringExplanation` | `read-model.ts:1751,2039` | Yes (SQL) | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Materials web unit/hook/component/a11y tests | `pnpm --filter @jobhunter/web test --run src/contexts/materials/` | 13 files, 42 tests passed | PASS |
| Web typecheck | `pnpm --filter @jobhunter/web exec tsc --noEmit` | exit 0 | PASS |
| API tests (incl. 4 generate-materials route cases) | `pnpm --filter @jobhunter/api test` | 10 files, 201 tests passed | PASS |
| Materials E2E live run | `pnpm --filter @jobhunter/web e2e materials.spec.ts` | FAILED at page-load (stale server on :8767 served wrong DB) | SKIP→human (environment, not code) |

### Requirements Coverage

| Requirement | Status | Evidence |
|---|---|---|
| INSPECT-01 (invokable; route; button; E2E unskipped) | SATISFIED (live E2E run → human) | server.ts route + 202/404/503 tests; button enabled + tests; spec unskipped |
| INSPECT-02 (employer analysis in-app) | SATISFIED | EmployerAnalysisPanel wired in drawer w/ canonical data |
| INSPECT-03 (per-bullet provenance) | SATISFIED | BulletProvenanceList all 5 dimensions |
| INSPECT-04 (diff view) | SATISFIED | BulletDiff original→tailored |
| INSPECT-05 (explicit states, never masked) | SATISFIED | Honest empty/missing/none states + per-state stories |
| INSPECT-06 (preserve last accepted artifact) | SATISFIED | Scoped optimistic patch + regression test + worker versioning |

### Anti-Patterns Found

None in the shipped materials/route files. (The single grep hit for "placeholder" at `server.ts:1096` is an unrelated endpoint's doc comment, outside this phase's surface.) No TODO/FIXME/XXX/TBD/HACK in the materials context or the generate-materials route.

### Human Verification Required

1. **Clean-environment materials E2E run.** Stop any API on port 8767 (`pnpm dev:stop` or kill the process), then run `pnpm --filter @jobhunter/web e2e materials.spec.ts`. Expected: the seeded GitLab "Director of Platform Engineering" row loads, the button is enabled, dispatch returns 202, and the injected ResumeApproved appears in Audit history. This closes INSPECT-01's live-E2E leg, which could not run here due to `reuseExistingServer` reusing a stale API bound to the real workspace DB.

### Gaps Summary

No blocking gaps. All four success criteria are achieved in the merged code with passing unit/integration tests (201 API + 42 web), passing typecheck, real data flow, honest missing-state rendering, per-state stories, and an unskipped E2E spec with correct assertions. The only open item is a Low-severity verification-environment WARNING: the live Playwright run could not exercise the seeded DB because a stale server occupied the E2E port — a runner artifact, not a defect in the shipped feature. Recommend a single clean-environment E2E run to fully close INSPECT-01.

---

_Verified: 2026-06-09T17:20:30Z_
_Verifier: Claude (gsd-verifier) — post-hoc reconciliation of merged PR #145_
