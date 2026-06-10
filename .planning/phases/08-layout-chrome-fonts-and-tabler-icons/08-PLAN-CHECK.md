# Phase 8 Plan Check - Layout Chrome, Fonts, And Tabler Icons

**Checked:** 2026-06-10
**Result:** PASS
**Plans checked:** 4
**Blockers:** 0
**Warnings:** 0

## Summary

Final re-check after the Plan 08-02 verification-command repair passes. The two previous blockers are fixed:

- The Tabler export checks now run from the repo root through the web workspace with `corepack pnpm --dir apps/web exec node ...`. I ran the aggregate export check from the repository root and it succeeded.
- The shell/shared lucide absence audit now uses `! rg -n "lucide-react" apps/web/src/shared/ui apps/web/src/shared/layout` without `|| true`. I ran it against the current pre-execution source and it exited nonzero while matches remain, proving the check fails if execution leaves shell/shared lucide imports behind.

The plan set covers LAYOUT-01 through LAYOUT-05 with shell chrome token work, font/density contract preservation, Tabler icon migration and deferral audit, focused behavior tests, browser route readability proof, review/QA gates, and final state reconciliation.

## Coverage Summary

| Requirement | Plans | Status |
|-------------|-------|--------|
| LAYOUT-01 | 08-01, 08-02, 08-03, 08-04 | Covered |
| LAYOUT-02 | 08-01, 08-03, 08-04 | Covered |
| LAYOUT-03 | 08-02, 08-03, 08-04 | Covered |
| LAYOUT-04 | 08-01, 08-03, 08-04 | Covered |
| LAYOUT-05 | 08-01, 08-04 | Covered |

## Plan Summary

| Plan | Tasks | Files | Wave | Status |
|------|-------|-------|------|--------|
| 08-01 | 3 | 8 | 1 | Valid |
| 08-02 | 3 | 11 | 1 | Valid |
| 08-03 | 3 | 4 | 2 | Valid |
| 08-04 | 3 | 7 | 3 | Valid |

## Evidence Summary

- `08-01-PLAN.md` covers shell chrome, token/font/density seams, and connection status visual treatment with token contract, `web:check`, and `git diff --check` verification.
- `08-02-PLAN.md` covers shell/shared Tabler icon migration and `08-ICON-AUDIT.md`. Its repaired export and absence checks now provide deterministic LAYOUT-03 verification.
- `08-03-PLAN.md` adds focused shell behavior tests for global search, theme toggle, density control, and connection status semantics.
- `08-04-PLAN.md` extends Playwright browser proof for theme/density persistence, global search URL behavior, nav active state, and LAYOUT-05 route readability over `/jobs`, `/apply-review`, and `/artifacts` or another artifact/PDF-adjacent surface.
- `08-RESEARCH.md` has `## Open Questions (RESOLVED)`.
- `08-VALIDATION.md` exists and maps LAYOUT-01 through LAYOUT-05 to automated checks, Wave 0 gaps, sampling continuity, and safety gates.
- `08-PATTERNS.md` maps all modified files to same-file analogs and shared accessibility, persistence, styling, and verification patterns.
- `AGENTS.md` constraints are reflected: no auto-apply/submission/destructive QA, synthetic/seeded evidence only, user-facing QA beyond unit tests, and no route/API/SSE behavior changes.

## Dimension Results

| Dimension | Status | Notes |
|-----------|--------|-------|
| Requirement Coverage | PASS | Every Phase 8 requirement appears in plan frontmatter and has concrete task coverage. |
| Task Completeness | PASS | All implementation tasks have files, action/behavior, automated verify, and done criteria. |
| Dependency Correctness | PASS | 08-01 and 08-02 are Wave 1; 08-03 depends on both; 08-04 depends on 08-01 through 08-03. No cycles or missing references found. |
| Key Links Planned | PASS | Component/CSS/test/audit/browser-proof links are represented in `must_haves.key_links` and task actions. |
| Scope Sanity | PASS | Each plan has 3 tasks and scoped file sets appropriate for this phase. |
| Verification Derivation | PASS | `must_haves.truths` are user-observable and tied to artifacts/key links. |
| Context Compliance | PASS | Locked decisions D-01 through D-18 are covered; deferred Phase 9/10/11 work is excluded except for explicit closeout deferrals. |
| Scope Reduction Detection | PASS | No `v1`, `static for now`, placeholder, stub, or future-enhancement language reduces locked decisions. |
| Architectural Tier Compliance | PASS | Work stays in browser/client shell, static CSS, tests, and planning artifacts per `08-RESEARCH.md` responsibility map. |
| Nyquist Compliance | PASS | `08-VALIDATION.md` exists; every task has automated verification; repaired 08-02 commands now enforce the intended signal. |
| Cross-Plan Data Contracts | PASS | Theme/density store, pre-paint shape, search URL contract, and icon audit handoffs are consistent across plans. |
| AGENTS.md Compliance | PASS | Plans use repo-standard commands, preserve frontend boundaries, include product-path QA, and avoid forbidden automation. |
| Research Resolution | PASS | Open questions are marked resolved. |
| Pattern Compliance | PASS | Plans reference and preserve the analog patterns from `08-PATTERNS.md`. |

## Dimension 8: Nyquist Compliance

| Task | Plan | Wave | Automated Command | Status |
|------|------|------|-------------------|--------|
| Task 1 | 08-01 | 1 | `corepack pnpm --filter @jobhunter/web test src/styles/token-contract.test.ts`; `corepack pnpm web:check` | PASS |
| Task 2 | 08-01 | 1 | `corepack pnpm --filter @jobhunter/web test src/styles/token-contract.test.ts`; `corepack pnpm web:check` | PASS |
| Task 3 | 08-01 | 1 | `corepack pnpm web:check`; `git diff --check` | PASS |
| Task 1 | 08-02 | 1 | `corepack pnpm --dir apps/web exec node -e ...`; `corepack pnpm web:check` | PASS |
| Task 2 | 08-02 | 1 | `corepack pnpm --filter @jobhunter/web test ...`; `! rg -n "lucide-react" apps/web/src/shared/ui apps/web/src/shared/layout`; `corepack pnpm web:check` | PASS |
| Task 3 | 08-02 | 1 | `rg "lucide-react\|@tabler/icons-react" apps/web/src apps/web/package.json`; `git diff --check` | PASS |
| Task 1 | 08-03 | 2 | `corepack pnpm --filter @jobhunter/web test src/shared/layout/Topbar.test.tsx`; `corepack pnpm web:check` | PASS |
| Task 2 | 08-03 | 2 | `corepack pnpm --filter @jobhunter/web test src/shared/layout/ThemeToggle.test.tsx`; `corepack pnpm web:check` | PASS |
| Task 3 | 08-03 | 2 | `corepack pnpm --filter @jobhunter/web test src/shared/layout/ConnectionStatusPill.test.tsx`; `corepack pnpm web:check` | PASS |
| Task 1 | 08-04 | 3 | `corepack pnpm --filter @jobhunter/web e2e -- tests/token-foundation.spec.ts`; `corepack pnpm web:check` | PASS |
| Task 2 | 08-04 | 3 | `corepack pnpm --filter @jobhunter/web e2e -- tests/token-foundation.spec.ts`; `corepack pnpm web:build` | PASS |
| Task 3 | 08-04 | 3 | unit/static/build/e2e/icon audit/`git diff --check` closeout commands | PASS |

Sampling: Wave 1: 6/6 verified -> PASS  
Sampling: Wave 2: 3/3 verified -> PASS  
Sampling: Wave 3: 3/3 verified -> PASS  
Wave 0: covered by `08-VALIDATION.md`; missing layout tests, E2E extension, and icon audit are created by implementation plans before dependent closeout -> PASS  
Overall: PASS

## Structured Issues

```yaml
issues: []
```

## Recommendation

Plans verified. Run `$gsd-execute-phase 8` to proceed.
