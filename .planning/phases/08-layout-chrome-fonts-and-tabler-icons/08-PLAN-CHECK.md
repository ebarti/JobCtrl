# Phase 8 Plan Check - Layout Chrome, Fonts, And Tabler Icons

**Checked:** 2026-06-10
**Result:** ISSUES FOUND
**Plans checked:** 4
**Blockers:** 2
**Warnings:** 0

## Summary

The repaired plans now satisfy the major goal-backward structure for LAYOUT-01 through LAYOUT-05: all four plans have executable frontmatter, requirement traces, `must_haves`, task-level actions, automated checks, explicit dependencies, resolved research questions, `08-VALIDATION.md`, an icon audit artifact, browser proof for Jobs/Apply Review/artifact-adjacent surfaces, and phase closeout gated on review/QA evidence.

The remaining blockers are both in Plan 08-02's automated verification contract. One planned Tabler export check is not runnable from the repository root, where plan commands are normally executed. Another planned absence audit is written with `|| true`, so it cannot fail if `lucide-react` imports remain in shell/shared UI after the migration. These are execution blockers because LAYOUT-03 depends on deterministic icon verification, not best-effort output.

## Coverage Summary

| Requirement | Plans | Status |
|-------------|-------|--------|
| LAYOUT-01 | 08-01, 08-02, 08-03, 08-04 | Covered |
| LAYOUT-02 | 08-01, 08-03, 08-04 | Covered |
| LAYOUT-03 | 08-02, 08-03, 08-04 | Blocked by non-runnable / non-failing icon verification commands in 08-02 |
| LAYOUT-04 | 08-01, 08-03, 08-04 | Covered |
| LAYOUT-05 | 08-01, 08-04 | Covered |

## Evidence Summary

- `08-01-PLAN.md` covers shell chrome, token/font/density seams, and connection status visual treatment with token contract, `web:check`, and `git diff --check` verification.
- `08-02-PLAN.md` covers shell/shared Tabler icon migration and `08-ICON-AUDIT.md`, but two automated commands need repair before execution.
- `08-03-PLAN.md` adds focused shell behavior tests for global search, theme toggle, density control, and connection status semantics.
- `08-04-PLAN.md` extends Playwright browser proof for theme/density persistence, global search URL behavior, nav active state, and LAYOUT-05 route readability over `/jobs`, `/apply-review`, and `/artifacts` or another artifact/PDF-adjacent surface.
- `08-RESEARCH.md` has `## Open Questions (RESOLVED)`.
- `08-VALIDATION.md` exists and maps LAYOUT-01 through LAYOUT-05 to automated checks, Wave 0 gaps, sampling continuity, and safety gates.
- `08-PATTERNS.md` maps all modified files to same-file analogs and shared accessibility, persistence, styling, and verification patterns.
- `AGENTS.md` constraints are reflected: no auto-apply/submission/destructive QA, synthetic/seeded evidence only, user-facing QA beyond unit tests, and no route/API/SSE behavior changes.

## Dimension Results

| Dimension | Status | Notes |
|-----------|--------|-------|
| Requirement Coverage | FAIL | LAYOUT-03 is blocked until 08-02 verification commands are deterministic. |
| Task Completeness | PASS | All implementation tasks have files, action/behavior, automated verify, and done criteria. |
| Dependency Correctness | PASS | 08-01 and 08-02 are Wave 1; 08-03 depends on both; 08-04 depends on 08-01 through 08-03. No cycles or missing references found. |
| Key Links Planned | PASS | Component/CSS/test/audit/browser-proof links are represented in `must_haves.key_links` and task actions. |
| Scope Sanity | PASS | Each plan has 3 tasks and scoped file sets appropriate for this phase. |
| Verification Derivation | PASS | `must_haves.truths` are user-observable and tied to artifacts/key links. |
| Context Compliance | PASS | Locked decisions D-01 through D-18 are covered; deferred Phase 9/10/11 work is excluded except for explicit closeout deferrals. |
| Scope Reduction Detection | PASS | No remaining `v1`, `static for now`, placeholder, stub, or future-enhancement language reduces locked decisions. |
| Architectural Tier Compliance | PASS | Work stays in browser/client shell, static CSS, tests, and planning artifacts per `08-RESEARCH.md` responsibility map. |
| Nyquist Compliance | FAIL | Automated verification exists, but two 08-02 commands cannot enforce the intended signal. |
| Cross-Plan Data Contracts | PASS | Theme/density store, pre-paint shape, search URL contract, and icon audit handoffs are consistent across plans. |
| AGENTS.md Compliance | FAIL | Repo QA rules require exact runnable verification; 08-02 has one command that fails from root and one command that masks failure. |
| Research Resolution | PASS | Open questions are marked resolved. |
| Pattern Compliance | PASS | Plans reference and preserve the analog patterns from `08-PATTERNS.md`. |

## Blockers

**1. [nyquist_compliance] Plan 08-02 Tabler export check fails from the repository root**
- Plan: `08-02`
- Task: 1
- Evidence: The planned command `node -e "const icons=require('@tabler/icons-react'); ..."` fails in `/private/tmp/JobHunter-shadcn-standard-token-milestone` with `Error: Cannot find module '@tabler/icons-react'`. The same check succeeds from `apps/web`.
- Impact: The first automated check in the icon migration plan will fail before validating anything, blocking execution or forcing ad hoc executor repair.
- Fix: Replace the root-resolution command with a workspace-aware command, for example:
  - `corepack pnpm --dir apps/web exec node -e "const icons=require('@tabler/icons-react'); for (const n of ['IconMoon','IconSun']) if (!icons[n]) throw new Error(n)"`
  - Also update the aggregate verification command in Plan 08-02 to use the same workspace-aware form for all listed Tabler exports.

**2. [nyquist_compliance] Plan 08-02 shared/layout lucide absence audit cannot fail**
- Plan: `08-02`
- Task: 2
- Evidence: The planned command `rg -n "lucide-react" apps/web/src/shared/ui apps/web/src/shared/layout || true` exits successfully whether matches exist or not. Current source contains `lucide-react` imports in `ThemeToggle.tsx` and multiple `shared/ui` files, so this command would not enforce the task's acceptance criterion after migration.
- Impact: LAYOUT-03 can appear verified while shell/shared user-visible chrome still silently mixes lucide and Tabler.
- Fix: Replace it with a failing absence check, for example:
  - `! rg -n "lucide-react" apps/web/src/shared/ui apps/web/src/shared/layout`
  - Keep the broader `rg "lucide-react|@tabler/icons-react" apps/web/src apps/web/package.json` audit in Task 3 for the explicit domain deferral ledger.

## Structured Issues

```yaml
issues:
  - plan: "08-02"
    dimension: "nyquist_compliance"
    severity: "blocker"
    task: 1
    description: "Tabler export verification command uses root Node resolution and cannot find @tabler/icons-react from the repo root."
    fix_hint: "Run the node export check through the apps/web workspace, e.g. corepack pnpm --dir apps/web exec node -e ..."
  - plan: "08-02"
    dimension: "nyquist_compliance"
    severity: "blocker"
    task: 2
    description: "Shared/layout lucide absence audit is masked with || true, so it cannot fail when lucide imports remain."
    fix_hint: "Use a failing absence check such as ! rg -n \"lucide-react\" apps/web/src/shared/ui apps/web/src/shared/layout."
```

## Recommendation

Do not execute Phase 8 yet. Return to the planner for a narrow 08-02 verification-command repair only. After those two command fixes, this plan set should be ready to pass the revision gate without changing scope.
