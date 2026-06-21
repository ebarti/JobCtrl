---
phase: 22
slug: product-path-qa-safety-release
status: passed
nyquist_compliant: true
wave_0_complete: true
created: 2026-06-21
verified_at: 2026-06-21
---

# Phase 22 — Validation Strategy

> Release QA validation contract for v1.3 compensation behavior. This file starts as the planning-time Nyquist strategy and should be updated during execution into the working QA matrix before final `22-VERIFICATION.md` summarizes the result.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.5 for API/web, pytest for Python worker tests, Playwright for e2e, jest-axe/axe-core for a11y |
| Config file | `apps/api/package.json`, `apps/web/package.json`, `apps/web/e2e/playwright.config.ts`, `workers/automation/pyproject.toml` |
| Quick run command | `git diff --check` plus the targeted command for the touched surface |
| Full suite command | `corepack pnpm test` plus `corepack pnpm --filter @jobhunter/web e2e -- tests/jobs-drawer.spec.ts` if e2e is not included in the root test gate |
| Estimated runtime | Targeted commands: minutes; full suite/e2e: longer, record exact runtime/results during execution |

---

## Decision Trace

| Decision | Locked Context Decision | Release Matrix Obligation |
|----------|--------------------------|---------------------------|
| D-01 | Fixture matrix covers every QA-01 scenario: below-floor posted salary, above-floor posted salary, missing posted salary, unparseable salary, broad posted range, OTE/equity ambiguity, exact company-role reported compensation, adjacent-role fallback, trimodal tier fallback, stale source, source conflict, low-confidence estimate, and insufficient evidence. | The fixture registry below names one stable `QA22-FX-*` row for every QA-01 scenario. |
| D-02 | Phase 22 uses synthetic jobs plus synthetic/manual reported compensation observations only; automated provider seams are simulated or fixture-backed. | Every fixture row has synthetic/manual safety notes and no provider credentials, real user data, screenshots, logs, local paths, or payload excerpts. |
| D-03 | Each fixture maps to the owning proof layer: parser confidence, market confidence, canonical API/projection data, Jobs list rendering, Jobs drawer rendering, or product-path safety boundary. | Owner layer is a required column in the fixture registry and execution matrix. |
| D-04 | The seeded `/jobs` human path must demonstrate visible states without requiring real `~/.jobhunter` data. | Browser/product-path rows use Playwright-seeded or disposable synthetic app data only. |
| D-05 | Automated evidence comes first for deterministic API, projection, worker-domain, and web invariants; manual QA is release-level visual/product-path confirmation. | Execution rows distinguish automated command evidence from final human-readable verification. |
| D-06 | Reuse existing named test files before adding coverage. | Matrix commands target `test_posted_compensation_parser.py`, `test_market_compensation_estimator.py`, `projections.test.ts`, `server.test.ts`, `JobsView.test.tsx`, `JobDetailDrawer.test.tsx`, and `jobs-drawer.spec.ts`. |
| D-07 | Playwright evidence must be seeded and disposable. | E2E rows use `apps/web/e2e/tests/jobs-drawer.spec.ts` and do not depend on real local data. |
| D-08 | Full-stack worker execution, worker-backed apply jobs, and real generated-material regeneration are not prerequisites for Phase 22 QA. | Release evidence must name no real generated-material regeneration and no worker-backed apply jobs. |
| D-09 | Compensation remains display/audit-only in v1.3. | QA-02 rows assert no fit-score, ranking, filtering, apply-readiness, blocker, handoff, or dispatch effect. |
| D-10 | Product-path checks compare the same job state with compensation present, weak, unavailable, or absent. | Execution matrix includes same-job safety rows covering present/weak/unavailable/absent compensation states. |
| D-11 | Safety evidence must name prohibited actions and exclude sensitive local data. | Validation and verification artifacts must state no auto-apply, no browser submission, no mailbox scanning, no real generated-material regeneration, no destructive profile/database actions, no real external scraping, and no worker-backed apply jobs. |
| D-12 | Final release verification artifact maps QA-01 through QA-06 to fixtures, tests, commands, and manual QA evidence. | Every matrix row links forward to `.planning/phases/22-product-path-qa-safety-release/22-VERIFICATION.md`. |
| D-13 | Reusable QA docs updates should be narrow and owned by `docs/local-reliability-qa.md`. | Docs updates are deferred to later Phase 22 plans unless the final release matrix becomes reusable procedure. |
| D-14 | Residual risk must be recorded when broad gates are skipped or blocked. | Final verification rows include residual-risk status and skipped-gate reasons when applicable. |

---

## Fixture Registry

| Fixture ID | Scenario | Requirements | Owner Layer | Evidence File | Command | Safety Notes |
|------------|----------|--------------|-------------|---------------|---------|--------------|
| QA22-FX-BELOW-FLOOR | Posted salary below profile floor produces warning-only comparison. | QA-01, QA-02, QA-05 | API projection + Jobs drawer | `apps/api/test/projections.test.ts`; `apps/api/test/server.test.ts`; `apps/web/src/views/jobs/JobDetailDrawer.test.tsx` | `corepack pnpm api:test -- projections.test.ts server.test.ts`; `corepack pnpm --filter @jobhunter/web exec vitest run src/views/jobs/JobDetailDrawer.test.tsx` | Synthetic posted salary and synthetic profile-floor threshold only; no profile data, no generated artifacts, no dispatch. |
| QA22-FX-ABOVE-FLOOR | Posted salary above profile floor stays display-only and does not create a warning gate. | QA-01, QA-02, QA-04 | API/Python projection parity | `apps/api/test/projections.test.ts`; `workers/automation/tests/test_projection_builder.py` | `corepack pnpm api:test -- projections.test.ts`; `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_projection_builder.py` | Synthetic canonical rows only; floor comparison remains warning-only and omits private preference details. |
| QA22-FX-MISSING-POSTED | Missing posted salary renders as an explicit missing state. | QA-01, QA-05 | Parser/API/Jobs list/drawer | `workers/automation/tests/test_posted_compensation_parser.py`; `apps/api/test/posted-compensation-facts.test.ts`; `apps/web/src/views/jobs/JobsView.test.tsx`; `apps/web/src/views/jobs/JobDetailDrawer.test.tsx` | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_posted_compensation_parser.py`; `corepack pnpm api:test -- posted-compensation-facts.test.ts`; `corepack pnpm --filter @jobhunter/web exec vitest run src/views/jobs/JobsView.test.tsx src/views/jobs/JobDetailDrawer.test.tsx` | Synthetic job with absent salary fields only; no real `~/.jobhunter` data. |
| QA22-FX-UNPARSEABLE | Unparseable posted salary preserves raw fallback while avoiding normalized salary claims. | QA-01, QA-03, QA-05 | Parser/API/drawer audit | `workers/automation/tests/test_posted_compensation_parser.py`; `apps/api/test/posted-compensation-facts.test.ts`; `apps/web/src/views/jobs/JobDetailDrawer.test.tsx` | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_posted_compensation_parser.py`; `corepack pnpm api:test -- posted-compensation-facts.test.ts`; `corepack pnpm --filter @jobhunter/web exec vitest run src/views/jobs/JobDetailDrawer.test.tsx` | Synthetic ambiguous posting text only; no provider payloads or screenshots. |
| QA22-FX-BROAD-RANGE | Broad posted range downgrades confidence and records parser warning. | QA-01, QA-03 | Parser/API | `workers/automation/tests/test_posted_compensation_parser.py`; `apps/api/test/posted-compensation-facts.test.ts` | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_posted_compensation_parser.py`; `corepack pnpm api:test -- posted-compensation-facts.test.ts` | Synthetic salary text only; no salary ranking or filter behavior. |
| QA22-FX-OTE-EQUITY | OTE/equity ambiguity remains explicit without adding total-compensation modeling. | QA-01, QA-03 | Parser/API/drawer audit | `workers/automation/tests/test_posted_compensation_parser.py`; `apps/api/test/posted-compensation-facts.test.ts`; `apps/web/src/views/jobs/JobDetailDrawer.test.tsx` | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_posted_compensation_parser.py`; `corepack pnpm api:test -- posted-compensation-facts.test.ts`; `corepack pnpm --filter @jobhunter/web exec vitest run src/views/jobs/JobDetailDrawer.test.tsx` | Synthetic OTE/equity copy only; no real generated-material regeneration. |
| QA22-FX-EXACT-COMPANY-ROLE | Exact company-role reported compensation estimate exposes range, confidence, and source trail. | QA-01, QA-03, QA-04, QA-05 | Market estimator/API/projection/Jobs drawer | `workers/automation/tests/test_market_compensation_estimator.py`; `apps/api/test/market-compensation-estimates.test.ts`; `apps/api/test/projections.test.ts`; `apps/web/src/views/jobs/JobDetailDrawer.test.tsx` | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_market_compensation_estimator.py`; `corepack pnpm api:test -- market-compensation-estimates.test.ts projections.test.ts`; `corepack pnpm --filter @jobhunter/web exec vitest run src/views/jobs/JobDetailDrawer.test.tsx` | Synthetic/manual reported rows only; Levels.fyi/Glassdoor are represented as permitted fixture sources, not live access. |
| QA22-FX-ADJACENT-ROLE | Adjacent-role company fallback records explicit fallback warning and confidence downgrade. | QA-01, QA-03 | Market estimator | `workers/automation/tests/test_market_compensation_estimator.py` | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_market_compensation_estimator.py` | Synthetic/manual observations only; no real external scraping. |
| QA22-FX-TRIMODAL-TIER-FALLBACK | Trimodal tier fallback records tier-role fallback and inferred tier evidence. | QA-01, QA-03 | Market estimator + API/projection evidence if persisted by later plans | `workers/automation/tests/test_market_compensation_estimator.py`; `apps/api/test/market-compensation-estimates.test.ts`; `apps/api/test/projections.test.ts` | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_market_compensation_estimator.py`; `corepack pnpm api:test -- market-compensation-estimates.test.ts projections.test.ts` | Synthetic tier observations only; no provider network access. |
| QA22-FX-STALE-SOURCE | Stale reported source becomes source-unavailable or stale warning state. | QA-01, QA-03, QA-05 | Market estimator/API/Jobs drawer | `workers/automation/tests/test_market_compensation_estimator.py`; `apps/api/test/market-compensation-estimates.test.ts`; `apps/web/src/views/jobs/JobDetailDrawer.test.tsx` | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_market_compensation_estimator.py`; `corepack pnpm api:test -- market-compensation-estimates.test.ts`; `corepack pnpm --filter @jobhunter/web exec vitest run src/views/jobs/JobDetailDrawer.test.tsx` | Synthetic aged observation metadata only; no mailbox scanning or provider calls. |
| QA22-FX-SOURCE-CONFLICT | Posted-vs-market source conflict is visible as audit warning, not a blocker. | QA-01, QA-03, QA-05 | Market estimator + Jobs list/drawer/e2e | `workers/automation/tests/test_market_compensation_estimator.py`; `apps/web/src/views/jobs/JobsView.test.tsx`; `apps/web/src/views/jobs/JobDetailDrawer.test.tsx`; `apps/web/e2e/tests/jobs-drawer.spec.ts` | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_market_compensation_estimator.py`; `corepack pnpm --filter @jobhunter/web exec vitest run src/views/jobs/JobsView.test.tsx src/views/jobs/JobDetailDrawer.test.tsx`; `corepack pnpm --filter @jobhunter/web e2e -- tests/jobs-drawer.spec.ts` | Synthetic posted and reported values only; no apply readiness or dispatch effect. |
| QA22-FX-LOW-CONFIDENCE | Weak source quality, sample count, freshness, match, location, component, dispersion, or agreement degrades confidence. | QA-01, QA-03, QA-05 | Market estimator/API/Jobs list | `workers/automation/tests/test_market_compensation_estimator.py`; `apps/api/test/market-compensation-estimates.test.ts`; `apps/web/src/views/jobs/JobsView.test.tsx` | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_market_compensation_estimator.py`; `corepack pnpm api:test -- market-compensation-estimates.test.ts`; `corepack pnpm --filter @jobhunter/web exec vitest run src/views/jobs/JobsView.test.tsx` | Synthetic weak evidence only; no salary ranking, filtering, or gates. |
| QA22-FX-INSUFFICIENT-EVIDENCE | Insufficient reported compensation evidence shows explicit insufficient state instead of a precise market range. | QA-01, QA-03, QA-05 | Market estimator/API/Jobs list/drawer | `workers/automation/tests/test_market_compensation_estimator.py`; `apps/api/test/market-compensation-estimates.test.ts`; `apps/web/src/views/jobs/JobsView.test.tsx`; `apps/web/src/views/jobs/JobDetailDrawer.test.tsx` | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_market_compensation_estimator.py`; `corepack pnpm api:test -- market-compensation-estimates.test.ts`; `corepack pnpm --filter @jobhunter/web exec vitest run src/views/jobs/JobsView.test.tsx src/views/jobs/JobDetailDrawer.test.tsx` | Synthetic/manual observations only; no auto-apply, no browser submission, no mailbox scanning, no real generated-material regeneration, no destructive profile/database actions, no real external scraping, and no worker-backed apply jobs. |

---

## Sampling Rate

- **After every task commit:** Run `git diff --check` and the targeted test command for the touched files.
- **After every plan wave:** Run Python parser/estimator/projection tests, API compensation/server tests, web Jobs unit/a11y tests, `web:check`, and Playwright `jobs-drawer.spec.ts`.
- **Before phase verification:** Run the Phase 22 release gate commands listed below, or record concrete blocker/skipped-gate reasons.
- **Max feedback latency:** Prefer under 5 minutes for targeted checks; do not batch multiple risky changes without a targeted test.

---

## Source Coverage Audit

| Source Type | Source | Coverage Status | Plan Coverage | Evidence / Decision Link |
|-------------|--------|-----------------|---------------|--------------------------|
| GOAL | Phase 22 roadmap goal: users can rely on v1.3 compensation behavior through synthetic/manual QA and no prohibited actions. | Covered | Plans 22-01, 22-02, 22-03, 22-04 | Roadmap Phase 22 plus this validation matrix. |
| REQ | QA-01 synthetic fixture coverage for all posted and market states. | Covered | Plans 22-01, 22-02, 22-03, 22-04 | Fixture registry plus backend/API/frontend/e2e execution rows. |
| REQ | QA-02 salary estimates do not change fit score, apply readiness, handoff, ranking, filtering, or auto-apply behavior. | Covered | Plans 22-01, 22-03, 22-04 | Product-path safety rows and final release gate. |
| REQ | QA-03 backend parser and market confidence degrade for weak evidence. | Covered | Plans 22-01, 22-02, 22-04 | Parser and estimator command rows. |
| REQ | QA-04 API/projection data comes from canonical rows and stays parity-safe. | Covered | Plans 22-01, 22-02, 22-04 | TypeScript API projection and Python projection command rows. |
| REQ | QA-05 frontend renders posted, estimated, unavailable, insufficient-evidence, warning-only floor, and source-conflict states. | Covered | Plans 22-01, 22-03, 22-04 | Jobs unit/a11y and Playwright command rows. |
| REQ | QA-06 QA uses synthetic/manual data only and avoids prohibited actions. | Covered | Plans 22-01, 22-03, 22-04 | Safety-boundary rows and final verification artifact. |
| RESEARCH | Release matrix is the single source for QA-01 through QA-06 fixture/test/command evidence. | Covered | Plan 22-01 | This file's fixture registry and execution matrix. |
| RESEARCH | Backend confidence gaps include trimodal fallback and weak-factor degradation. | Covered | Plan 22-02 | `workers/automation/tests/test_market_compensation_estimator.py` execution row. |
| RESEARCH | API/projection canonical parity must remain the compensation source of truth. | Covered | Plan 22-02 | `apps/api/test/projections.test.ts` and `workers/automation/tests/test_projection_builder.py` execution rows. |
| RESEARCH | Frontend source-conflict visibility should be asserted explicitly. | Covered | Plan 22-03 | Jobs drawer/list and Playwright source-conflict rows. |
| RESEARCH | Playwright path must be seeded and disposable. | Covered | Plan 22-03 | `apps/web/e2e/tests/jobs-drawer.spec.ts` row and D-07. |
| RESEARCH | Package-install prohibition applies; no new packages are planned. | Covered | Plans 22-01, 22-04 | T-22-SC threat and final verification artifact. |
| RESEARCH | Final release gate records command results, residual risk, and safety boundaries. | Covered | Plan 22-04 | `.planning/phases/22-product-path-qa-safety-release/22-VERIFICATION.md`. |
| CONTEXT | D-01 fixture matrix covers every QA-01 scenario. | Covered | Plan 22-01 | Decision Trace D-01 and Fixture Registry. |
| CONTEXT | D-02 synthetic/manual data only. | Covered | Plans 22-01, 22-04 | Decision Trace D-02 and safety notes. |
| CONTEXT | D-03 owner-layer mapping. | Covered | Plans 22-01, 22-02, 22-03 | Owner Layer columns in registry and matrix. |
| CONTEXT | D-04 seeded `/jobs` human path. | Covered | Plans 22-01, 22-03, 22-04 | Playwright and manual verification rows. |
| CONTEXT | D-05 automated-first split. | Covered | Plans 22-01, 22-02, 22-03, 22-04 | Command rows precede final manual verification. |
| CONTEXT | D-06 reuse existing named test files. | Covered | Plans 22-01, 22-02, 22-03 | Command rows target existing named tests. |
| CONTEXT | D-07 seeded disposable Playwright path. | Covered | Plans 22-03, 22-04 | Playwright row and final verification. |
| CONTEXT | D-08 no full-stack worker/apply/material prerequisite. | Covered | Plans 22-01, 22-04 | Safety rows and prohibited-action evidence. |
| CONTEXT | D-09 compensation remains display/audit-only. | Covered | Plans 22-02, 22-03, 22-04 | QA-02 execution rows. |
| CONTEXT | D-10 same-job present/weak/unavailable/absent comparison. | Covered | Plans 22-03, 22-04 | Same-job safety execution row. |
| CONTEXT | D-11 prohibited-action and sensitive-data evidence. | Covered | Plans 22-01, 22-04 | Safety notes and final verification. |
| CONTEXT | D-12 final verification artifact. | Covered | Plan 22-04 | `.planning/phases/22-product-path-qa-safety-release/22-VERIFICATION.md`. |
| CONTEXT | D-13 narrow reusable QA docs update. | Covered | Plan 22-04 | Docs update decision is evaluated at the release gate. |
| CONTEXT | D-14 residual-risk recording. | Covered | Plan 22-04 | Final verification residual-risk section. |

---

## Release Gate Commands

```bash
uv --project workers/automation run --extra dev pytest -q \
  workers/automation/tests/test_posted_compensation_parser.py \
  workers/automation/tests/test_market_compensation_estimator.py \
  workers/automation/tests/test_projection_builder.py \
  workers/automation/tests/test_compensation_refresh_cli.py

corepack pnpm api:test -- \
  server.test.ts \
  projections.test.ts \
  posted-compensation-facts.test.ts \
  market-compensation-estimates.test.ts

corepack pnpm --filter @jobhunter/contracts check
corepack pnpm api:check
corepack pnpm web:check
corepack pnpm web:build

corepack pnpm --filter @jobhunter/web exec vitest run \
  src/views/jobs/JobsView.test.tsx \
  src/views/jobs/JobDetailDrawer.test.tsx \
  src/views/jobs/JobDetailDrawer.a11y.test.tsx \
  src/contexts/operations/invalidation-router.test.ts \
  src/contexts/operations/every-event-has-handler.test.ts

corepack pnpm --filter @jobhunter/web e2e -- tests/jobs-drawer.spec.ts
git diff --check
git status --short
```

---

## Execution Matrix

| Matrix ID | Plan ID | Fixture / Boundary | Requirements | Threat Ref | Owner Layer | Exact Command | Final Evidence Path | Status |
|-----------|---------|--------------------|--------------|------------|-------------|---------------|---------------------|--------|
| 22-01-MATRIX | 22-01 | Decision trace, fixture registry, and source audit | QA-01, QA-02, QA-03, QA-04, QA-05, QA-06 | T-22-01 / T-22-02 / T-22-03 / T-22-04 / T-22-SC | Release validation artifact | `rg -n "QA22-FX-|Source Coverage Audit|D-01|D-14|T-22-01|T-22-04" .planning/phases/22-product-path-qa-safety-release/22-VALIDATION.md` | `.planning/phases/22-product-path-qa-safety-release/22-VERIFICATION.md` | green - PASS: grep matched fixture registry, source audit, D-01/D-14, and threat refs. |
| 22-02-BELOW-FLOOR | 22-02 | QA22-FX-BELOW-FLOOR | QA-01, QA-02, QA-04, QA-05 | T-22-02 / T-22-04 | API projection + Jobs drawer | `corepack pnpm api:test -- projections.test.ts server.test.ts` | `.planning/phases/22-product-path-qa-safety-release/22-VERIFICATION.md` | green - PASS: API release gate covered server/projections in 14 files / 272 tests; web release gate covered drawer in 5 files / 218 tests. |
| 22-02-ABOVE-FLOOR | 22-02 | QA22-FX-ABOVE-FLOOR | QA-01, QA-02, QA-04 | T-22-02 / T-22-04 | API and Python projection parity | `corepack pnpm api:test -- projections.test.ts && uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_projection_builder.py` | `.planning/phases/22-product-path-qa-safety-release/22-VERIFICATION.md` | green - PASS: API release gate covered projections in 14 files / 272 tests; Python release gate covered projection builder in 61 tests. |
| 22-02-MISSING-POSTED | 22-02 | QA22-FX-MISSING-POSTED | QA-01, QA-03, QA-05 | T-22-03 | Parser + posted API | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_posted_compensation_parser.py && corepack pnpm api:test -- posted-compensation-facts.test.ts` | `.planning/phases/22-product-path-qa-safety-release/22-VERIFICATION.md` | green - PASS: Python release gate covered posted parser in 61 tests; API release gate covered posted compensation facts in 14 files / 272 tests. |
| 22-02-UNPARSEABLE | 22-02 | QA22-FX-UNPARSEABLE | QA-01, QA-03, QA-05 | T-22-03 | Parser + posted API | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_posted_compensation_parser.py && corepack pnpm api:test -- posted-compensation-facts.test.ts` | `.planning/phases/22-product-path-qa-safety-release/22-VERIFICATION.md` | green - PASS: Python release gate covered posted parser in 61 tests; API release gate covered posted compensation facts in 14 files / 272 tests. |
| 22-02-BROAD-RANGE | 22-02 | QA22-FX-BROAD-RANGE | QA-01, QA-03 | T-22-03 | Parser + posted API | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_posted_compensation_parser.py && corepack pnpm api:test -- posted-compensation-facts.test.ts` | `.planning/phases/22-product-path-qa-safety-release/22-VERIFICATION.md` | green - PASS: Python release gate covered posted parser in 61 tests; API release gate covered posted compensation facts in 14 files / 272 tests. |
| 22-02-OTE-EQUITY | 22-02 | QA22-FX-OTE-EQUITY | QA-01, QA-03 | T-22-03 | Parser + posted API | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_posted_compensation_parser.py && corepack pnpm api:test -- posted-compensation-facts.test.ts` | `.planning/phases/22-product-path-qa-safety-release/22-VERIFICATION.md` | green - PASS: Python release gate covered posted parser in 61 tests; API release gate covered posted compensation facts in 14 files / 272 tests. |
| 22-02-EXACT-COMPANY-ROLE | 22-02 | QA22-FX-EXACT-COMPANY-ROLE | QA-01, QA-03, QA-04, QA-05 | T-22-02 / T-22-03 / T-22-04 | Market estimator + API/projection | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_market_compensation_estimator.py && corepack pnpm api:test -- market-compensation-estimates.test.ts projections.test.ts` | `.planning/phases/22-product-path-qa-safety-release/22-VERIFICATION.md` | green - PASS: Python release gate covered market estimator in 61 tests; API release gate covered market estimates/projections in 14 files / 272 tests. |
| 22-02-ADJACENT-ROLE | 22-02 | QA22-FX-ADJACENT-ROLE | QA-01, QA-03 | T-22-02 | Market estimator | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_market_compensation_estimator.py` | `.planning/phases/22-product-path-qa-safety-release/22-VERIFICATION.md` | green - PASS: Python release gate covered market estimator in 61 tests. |
| 22-02-TRIMODAL-TIER | 22-02 | QA22-FX-TRIMODAL-TIER-FALLBACK | QA-01, QA-03, QA-04 | T-22-02 / T-22-04 | Market estimator + API/projection | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_market_compensation_estimator.py && corepack pnpm api:test -- market-compensation-estimates.test.ts projections.test.ts` | `.planning/phases/22-product-path-qa-safety-release/22-VERIFICATION.md` | green - PASS: Python release gate covered market estimator in 61 tests; API release gate covered market estimates/projections in 14 files / 272 tests. |
| 22-02-STALE-SOURCE | 22-02 | QA22-FX-STALE-SOURCE | QA-01, QA-03, QA-05 | T-22-02 / T-22-03 | Market estimator + market API | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_market_compensation_estimator.py && corepack pnpm api:test -- market-compensation-estimates.test.ts` | `.planning/phases/22-product-path-qa-safety-release/22-VERIFICATION.md` | green - PASS: Python release gate covered market estimator in 61 tests; API release gate covered market estimates in 14 files / 272 tests. |
| 22-02-LOW-CONFIDENCE | 22-02 | QA22-FX-LOW-CONFIDENCE | QA-01, QA-03, QA-05 | T-22-02 | Market estimator + market API | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_market_compensation_estimator.py && corepack pnpm api:test -- market-compensation-estimates.test.ts` | `.planning/phases/22-product-path-qa-safety-release/22-VERIFICATION.md` | green - PASS: Python release gate covered market estimator in 61 tests; API release gate covered market estimates in 14 files / 272 tests. |
| 22-02-INSUFFICIENT | 22-02 | QA22-FX-INSUFFICIENT-EVIDENCE | QA-01, QA-03, QA-05 | T-22-02 / T-22-03 | Market estimator + market API | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_market_compensation_estimator.py && corepack pnpm api:test -- market-compensation-estimates.test.ts` | `.planning/phases/22-product-path-qa-safety-release/22-VERIFICATION.md` | green - PASS: Python release gate covered market estimator in 61 tests; API release gate covered market estimates in 14 files / 272 tests. |
| 22-03-SOURCE-CONFLICT | 22-03 | QA22-FX-SOURCE-CONFLICT | QA-01, QA-03, QA-05 | T-22-02 / T-22-03 | Jobs list/drawer + Playwright | `corepack pnpm --filter @jobhunter/web exec vitest run src/views/jobs/JobsView.test.tsx src/views/jobs/JobDetailDrawer.test.tsx && corepack pnpm --filter @jobhunter/web e2e -- tests/jobs-drawer.spec.ts` | `.planning/phases/22-product-path-qa-safety-release/22-VERIFICATION.md` | green - PASS: web release gate covered Jobs/drawer/a11y/invalidation in 5 files / 218 tests; Playwright passed 4 tests. |
| 22-03-FRONTEND-STATES | 22-03 | Posted, estimated, unavailable, insufficient-evidence, warning-only floor, and source-conflict visible states | QA-01, QA-02, QA-05 | T-22-02 / T-22-03 | Jobs list/drawer unit + a11y | `corepack pnpm --filter @jobhunter/web exec vitest run src/views/jobs/JobsView.test.tsx src/views/jobs/JobDetailDrawer.test.tsx src/views/jobs/JobDetailDrawer.a11y.test.tsx` | `.planning/phases/22-product-path-qa-safety-release/22-VERIFICATION.md` | green - PASS: web release gate covered Jobs/drawer/a11y in 5 files / 218 tests. |
| 22-03-SAME-JOB-SAFETY | 22-03 | Same-job compensation present/weak/unavailable/absent comparison keeps non-compensation controls unchanged | QA-02, QA-06 | T-22-01 / T-22-02 | API boundary + Jobs UI | `corepack pnpm api:test -- server.test.ts && corepack pnpm --filter @jobhunter/web exec vitest run src/views/jobs/JobsView.test.tsx src/views/jobs/JobDetailDrawer.test.tsx` | `.planning/phases/22-product-path-qa-safety-release/22-VERIFICATION.md` | green - PASS: API release gate covered server in 14 files / 272 tests; web release gate covered Jobs/drawer in 5 files / 218 tests. |
| 22-03-PLAYWRIGHT-PATH | 22-03 | Seeded `/jobs` product path, Apply Review handoff, no compensation sort/filter controls | QA-02, QA-05, QA-06 | T-22-01 / T-22-02 | Playwright seeded e2e | `corepack pnpm --filter @jobhunter/web e2e -- tests/jobs-drawer.spec.ts` | `.planning/phases/22-product-path-qa-safety-release/22-VERIFICATION.md` | green - PASS: Playwright passed 4 tests using seeded `/jobs` data. |
| 22-04-RELEASE-GATE | 22-04 | Final command gate, residual risk, and safety boundaries | QA-01, QA-02, QA-03, QA-04, QA-05, QA-06 | T-22-01 / T-22-02 / T-22-03 / T-22-04 / T-22-SC | Final verification artifact | `git diff --check && git status --short` plus release gate commands above | `.planning/phases/22-product-path-qa-safety-release/22-VERIFICATION.md` | green - PASS: all release gate commands passed; no command was skipped or blocked. |

*Status values: pending, green, red, skipped, blocked. Deferred ideas from the phase context are intentionally absent from execution rows.*

---

## Release Matrix Requirements

The execution plan must update this file with a matrix that maps each row below to fixture data, owner layer, automated evidence, command result, and manual/browser evidence where applicable.

| Scenario / Boundary | Requirements | Minimum Evidence |
|---------------------|--------------|------------------|
| Below-floor posted salary | QA-01, QA-02, QA-05 | Projection/API evidence plus Jobs drawer warning-only copy |
| Above-floor posted salary | QA-01, QA-02 | Projection/API floor comparison evidence showing no warning gate |
| Missing posted salary | QA-01, QA-05 | Parser/API/web explicit missing state evidence |
| Unparseable salary | QA-01, QA-03, QA-05 | Parser/API state evidence and drawer explicit state if surfaced |
| Broad posted range | QA-01, QA-03 | Parser warning evidence; UI evidence only if surfaced in current audit copy |
| OTE/equity ambiguity | QA-01, QA-03 | Parser warning/confidence evidence; no new OTE/equity modeling |
| Exact company-role reported compensation | QA-01, QA-03, QA-04, QA-05 | Estimator/API/projection evidence plus source trail if visible |
| Adjacent-role fallback | QA-01, QA-03 | Estimator fallback warning evidence |
| Trimodal tier fallback | QA-01, QA-03 | Focused estimator test and canonical/API evidence if persisted visibility is added |
| Stale source | QA-01, QA-03, QA-05 | Market state/reason evidence; source-unavailable or stale warning preserved |
| Source conflict | QA-01, QA-03, QA-05 | Estimator warning plus explicit Jobs drawer/list or Playwright visibility assertion |
| Low-confidence estimate | QA-01, QA-03, QA-05 | Estimator confidence degradation and web/API state evidence |
| Insufficient evidence | QA-01, QA-03, QA-05 | Market insufficient state evidence in API and UI |
| Fit score unchanged | QA-02 | API/web assertion that compensation does not affect fit score |
| Ranking/filtering unchanged | QA-02 | API/web assertion that compensation sort/filter/query fields are absent |
| Apply readiness and handoff unchanged | QA-02 | Drawer/apply audit and Playwright handoff evidence |
| Apply/dispatch controls unchanged | QA-02, QA-06 | API/web assertion and prohibited-action evidence |
| Canonical/parity safety | QA-04 | TypeScript and Python projection tests |
| Synthetic/manual-only QA | QA-06 | Command/evidence log confirms no real provider, user data, browser submission, mailbox, material regeneration, destructive action, or worker-backed apply job |

---

## Wave 0 Requirements

- [x] Add release matrix rows to this file before or during the first implementation plan.
- [x] Confirm whether `workers/automation/tests/test_market_compensation_estimator.py` lacks trimodal tier fallback and weak-factor degradation tests; add them if missing.
- [x] Confirm whether `apps/web/src/views/jobs/JobDetailDrawer.test.tsx` or `apps/web/e2e/tests/jobs-drawer.spec.ts` explicitly asserts source-conflict visibility; add the smallest assertion if missing.
- [x] Record prohibited-action boundaries in the matrix before running product-path QA.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Human-verifier product path for Jobs compensation triage | QA-01, QA-02, QA-05, QA-06 | Browser visibility and release confidence need a human-readable artifact even when Playwright owns the deterministic assertions | Use the Playwright-seeded `/jobs` fixture only. Verify Posted, Market, Warnings, drawer `Compensation audit`, source trail, confidence factors, missing/unavailable/insufficient/source-conflict states, warning-only copy, no compensation sort/filter controls, and no prohibited actions. |

---

## Validation Sign-Off

- [x] All release matrix rows have automated evidence or an explicit manual-only reason.
- [x] QA-01 through QA-06 are each covered by at least one command or manual-verification row.
- [x] Sampling continuity: no risky code/test/doc task ships without a targeted command.
- [x] No watch-mode commands.
- [x] No auto-apply, browser submission, mailbox scanning, real generated-material regeneration, destructive profile/database action, real external scraping, or worker-backed apply job.
- [x] `nyquist_compliant: true` set in frontmatter after execution evidence is complete.

**Approval:** passed
