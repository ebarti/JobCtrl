---
phase: 21-jobs-triage-ux-warning-only-floor
fixed_at: 2026-06-21T01:41:07Z
review_path: .planning/phases/21-jobs-triage-ux-warning-only-floor/21-REVIEW.md
iteration: 16
findings_in_scope: 18
fixed: 18
skipped: 0
status: all_fixed
---

# Phase 21: Code Review Fix Report

**Fixed at:** 2026-06-21T01:41:07Z
**Source review:** `.planning/phases/21-jobs-triage-ux-warning-only-floor/21-REVIEW.md`
**Iteration:** 16

**Summary:**
- Findings in scope: 18
- Fixed: 18
- Skipped: 0

## Fixed Issues

### CR-01: Malformed compensation rows with shallow or nested invalid compensation payloads still crash the drawer

**Status:** fixed: requires human verification
**Files modified:** `apps/api/src/read-model.ts`, `apps/api/src/projections.ts`, `apps/api/test/projections.test.ts`, `apps/web/src/views/jobs/JobCompensationAuditSection.tsx`, `apps/web/src/views/jobs/JobDetailDrawer.test.tsx`, `workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py`, `workers/automation/tests/test_projection_builder.py`
**Commits:** aa0c874, 5153a1f, 6f45804, cea63e5
**Applied fix:** Split API compensation JSON guards into summary and audit contract checks that require valid `posted`, `market`, and `floorComparison` arm discriminants. Updated TS and Python stale-projection detection to rebuild rows whose summary/audit JSON is missing or malformed for `floorComparison`, `floorComparison.posted`, `floorComparison.market`, `posted`, or `market`, including present-but-empty sibling objects, recorded arms with empty nested `fact` / `estimate` objects, and malformed floor comparison arms. Hardened the drawer to treat shallow or malformed compensation payloads as unavailable, preserving the existing warning-only behavior. Added TS, Python, and drawer regressions for shallow `floorComparison` JSON, malformed sibling data, malformed recorded nested payloads, and malformed floor comparison arms.

### CR-01 iteration 6: Malformed floor value still bypasses stale rebuild and renders as audit evidence

**Status:** fixed
**Files modified:** `apps/api/src/read-model.ts`, `apps/api/src/projections.ts`, `apps/api/test/projections.test.ts`, `apps/web/src/views/jobs/JobCompensationAuditSection.tsx`, `apps/web/src/views/jobs/JobDetailDrawer.test.tsx`, `apps/web/e2e/tests/jobs-drawer.spec.ts`, `workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py`, `workers/automation/tests/test_projection_builder.py`
**Commits:** 67b77da
**Applied fix:** Added explicit `floorComparison.floor` value guards in the API read model and drawer so a non-null floor must contain numeric `amount`, string `currency`, and annual `period`. Extended TS and Python stale-projection detection to rebuild rows with missing or malformed floor values while preserving the valid `floor: null` not-configured state. Added API, Python, and drawer regressions for stale JSON with `floorComparison.floor = {}` and aligned the product-path e2e assertion with the seeded both-posted-and-market basis.

### CR-01 iteration 7: Malformed floor comparison enum/value JSON can still bypass rebuild and break the drawer

**Status:** fixed
**Files modified:** `apps/api/src/read-model.ts`, `apps/api/src/projections.ts`, `apps/api/test/projections.test.ts`, `apps/web/src/views/jobs/JobCompensationAuditSection.tsx`, `apps/web/src/views/jobs/JobDetailDrawer.test.tsx`, `workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py`, `workers/automation/tests/test_projection_builder.py`
**Commits:** 4ae42dd
**Applied fix:** Tightened floor comparison runtime guards to whitelist valid root `state` and `basis` values, require nonnegative integer `warningCount`, require string warning labels, and require positive finite floor amounts with nonblank currency. Mirrored those checks in the TypeScript and Python stale-projection SQL for summary and audit JSON, including invalid root state/basis, invalid posted/market arm state, negative floor amount, blank floor currency, and malformed warning-label arrays. Added API, Python, and drawer regressions for invalid enum/value payloads while preserving valid warning-only floor states.

### CR-01 iteration 8: Non-floor compensation enums can still bypass rebuild and crash the drawer

**Status:** fixed
**Files modified:** `apps/api/src/read-model.ts`, `apps/api/src/projections.ts`, `apps/api/test/projections.test.ts`, `apps/web/src/views/jobs/JobCompensationAuditSection.tsx`, `apps/web/src/views/jobs/JobDetailDrawer.test.tsx`, `workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py`, `workers/automation/tests/test_projection_builder.py`
**Commits:** f99890e
**Applied fix:** Whitelisted posted summary/audit record statuses, parse states, confidence values, market summary/audit record statuses, estimate states, confidence bands, source counts, and warning counts in both runtime guards and stale-projection SQL. Added API, Python, and drawer regressions proving invalid posted/market enum payloads rebuild from canonical data or render unavailable instead of reaching the drawer formatters.

### CR-02 iteration 8: Comma-formatted profile floors are parsed as decimals, suppressing floor warnings

**Status:** fixed
**Files modified:** `apps/api/src/projections.ts`, `apps/api/test/projections.test.ts`, `workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py`, `workers/automation/tests/test_projection_builder.py`
**Commits:** f99890e
**Applied fix:** Updated TypeScript and Python profile floor parsing so comma-grouped values such as `120,000` parse as `120000`, while preserving positive numeric parsing. Added TS and Python projection tests that assert comma-formatted floors still produce below-floor warning-only evidence.

### WR-01 iteration 8: Monthly market estimates are compared to an annual floor without annualization

**Status:** fixed
**Files modified:** `apps/api/src/projections.ts`, `apps/api/test/projections.test.ts`, `workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py`, `workers/automation/tests/test_projection_builder.py`
**Commits:** f99890e
**Applied fix:** Added annualized minimum/maximum values for monthly market estimates before floor comparison in both TypeScript and Python projections. Added TS and Python coverage for monthly market estimates that meet the annual floor and monthly market estimates below the annual floor.

### CR-01 iteration 9: Profile floor updates leave valid-looking compensation audit JSON stale

**Status:** fixed
**Files modified:** `apps/api/src/projections.ts`, `apps/api/test/projections.test.ts`, `workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py`, `workers/automation/tests/test_projection_builder.py`
**Commits:** 8c09ea9
**Applied fix:** Treated jobless `ProfileUpdated` events as compensation-floor invalidation events in both TypeScript and Python projection refreshers. When a profile update is observed, all jobs are marked dirty so compensation summaries and drawer audit JSON rebuild from the current profile floor instead of retaining valid-shaped but stale floor comparisons. Added TS and Python projection regressions for a `95000` floor rebuilt after a `150000` profile update, asserting both posted and market arms become below-floor warning-only evidence.

### CR-01 iteration 10: Valid-but-stale floor JSON is never repaired after the profile floor changes

**Status:** fixed
**Files modified:** `apps/api/src/projections.ts`, `apps/api/test/projections.test.ts`, `workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py`, `workers/automation/tests/test_projection_builder.py`
**Commits:** 4754407
**Applied fix:** Added current canonical profile-floor comparison to the TypeScript and Python compensation stale-projection scans. Valid-shaped summary/detail JSON is now rebuilt when `floorComparison.floor` differs from the current tenant profile floor, including silent or already-watermarked profile changes. Added TS and Python regressions that build valid `95000` projections, update the profile floor to `150000` without relying on a new event, and assert summary/audit floor evidence and warning labels are recomputed.

### WR-01 iteration 10: TS projection reads the local profile floor for every tenant

**Status:** fixed
**Files modified:** `apps/api/src/projections.ts`, `apps/api/test/projections.test.ts`
**Commits:** 4754407
**Applied fix:** Threaded `tenantId` through the TypeScript compensation projection builder and profile-floor lookup, binding the tenant in the `candidate_profiles` query instead of hardcoding `local`. Added a TS projection regression that refreshes a non-local tenant while only the local tenant has a configured floor and asserts the non-local projection remains `not_configured`.

### WR-02 iteration 10: European thousands separators can turn salary floors into tiny numbers

**Status:** fixed
**Files modified:** `apps/api/src/projections.ts`, `apps/api/test/projections.test.ts`, `workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py`, `workers/automation/tests/test_projection_builder.py`
**Commits:** 4754407
**Applied fix:** Updated TypeScript and Python profile-floor numeric normalization to treat dot-grouped values such as `120.000` as thousands while preserving decimal forms such as `120.50` and comma decimals. Added TS and Python projection regressions for dot-thousands parsing and decimal preservation; existing comma-thousands regressions still cover `120,000`.

### CR-01 iteration 11: Python profile-floor parser can crash projection refresh on malformed numeric strings

**Status:** fixed
**Files modified:** `workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py`, `workers/automation/tests/test_projection_builder.py`
**Commits:** 76ff9ff
**Applied fix:** Wrapped Python profile-floor numeric conversion in `ValueError` handling so malformed numeric-looking tokens such as `120.000.50` are treated as no configured floor instead of crashing worker projection refresh. Added a Python projection regression that refreshes with a malformed floor and asserts the projected floor comparison is `floor_not_configured`.

### CR-01 iteration 12: Profile floor parsing treats shorthand floors as tiny annual amounts

**Status:** fixed
**Files modified:** `apps/api/src/projections.ts`, `apps/api/test/projections.test.ts`, `workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py`, `workers/automation/tests/test_projection_builder.py`
**Commits:** c79d46d
**Applied fix:** Updated TypeScript and Python profile-floor parsing to normalize whitespace thousands and `k`/`m` shorthand before numeric conversion. Added TS and Python projection regressions for `120k`, `€120k`, and `120 000`, asserting they project a `120000` annual floor and preserve below-floor warning-only evidence.

### CR-01 iteration 13: Profile floor updates do not invalidate cached jobs queries

**Status:** fixed
**Files modified:** `apps/web/src/contexts/profile/handlers.ts`, `apps/web/src/contexts/operations/invalidation-router.test.ts`
**Commits:** 62139f1
**Applied fix:** Updated the `ProfileUpdated` SSE handler to invalidate the full jobs query family in addition to the profile query, so list and open detail compensation-floor warnings refresh after profile-floor changes. Updated the invalidation-router exact-match regression to require `jobsKeys.all(tenantId)` for `ProfileUpdated`.

### WR-01 iteration 13: Jobs drawer E2E seeds an invalid CompensationFactsUpdated payload

**Status:** fixed
**Files modified:** `apps/web/e2e/tests/jobs-drawer.spec.ts`
**Commits:** 62139f1
**Applied fix:** Changed the Jobs drawer E2E seed to write a contract-shaped `CompensationFactsUpdated` payload with `jobId`, posted/market statuses, and `updatedAt`, and added a separate `ProfileUpdated` event for the seeded profile-floor change.

### CR-01 iteration 14: TypeScript compensation projections read local tenant compensation facts for every tenant

**Status:** fixed
**Files modified:** `apps/api/src/posted-compensation-facts.ts`, `apps/api/src/market-compensation-estimates.ts`, `apps/api/src/projections.ts`, `apps/api/test/projections.test.ts`
**Commits:** 1e70935
**Applied fix:** Added optional tenant arguments to the TypeScript posted and market compensation readers, threaded the projection tenant through `buildCompensationProjection`, and updated the non-local tenant projection regression to assert local-only posted and market compensation rows are not copied into another tenant's summary or audit JSON.

### CR-01 iteration 15: Projection watermarks and event reads are global across tenants

**Status:** fixed
**Files modified:** `apps/api/src/projections.ts`, `apps/api/test/projections.test.ts`, `workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py`, `workers/automation/tests/test_projection_builder.py`
**Commits:** 3bc9a90
**Applied fix:** Switched TypeScript and Python projection refreshers to tenant-scoped watermark names (`operations_projections:<tenant>`) and filtered `job_events` by `payload_json.tenantId`, defaulting missing legacy payloads to `local`. Applied the same tenant predicate to source-quality event rebuilds and Python apply-run materialization, and tightened tenant filters on apply-run reads and dashboard dry-run counts. Added TS and Python regressions proving a tenant-a refresh cannot advance past and drop a tenant-b compensation update.

### WR-01 iteration 15: One-sided compensation ranges are treated as not comparable

**Status:** fixed
**Files modified:** `apps/api/src/projections.ts`, `apps/api/test/projections.test.ts`, `workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py`, `workers/automation/tests/test_projection_builder.py`
**Commits:** 3bc9a90
**Applied fix:** Updated TypeScript and Python floor comparison logic so max-only ranges below the profile floor are comparable as `below_floor`, min-only ranges at or above the floor are comparable as `meets_floor`, and only straddling or boundless ranges remain `not_comparable`. Added TS and Python regressions for max-only below-floor and min-only meets-floor posted compensation.

### CR-01 iteration 16: One-sided market ranges still misclassify because missing bounds become zero

**Status:** fixed
**Files modified:** `apps/api/src/market-compensation-estimates.ts`, `apps/api/src/projections.ts`, `apps/api/test/projections.test.ts`, `packages/contracts/src/schemas.ts`, `workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py`, `workers/automation/tests/test_projection_builder.py`
**Commits:** 16b84a5
**Applied fix:** Preserved nullable market estimate minimum and maximum bounds instead of coercing missing values to `0`, updated monthly annualization to annualize only present bounds, and changed the shared contract type for market estimated ranges to allow nullable bounds. Added TS and Python projection regressions for max-only market ranges below the floor and min-only market ranges meeting the floor.

## Skipped Issues

None.

## Verification

- `git diff --check` - passed.
- `corepack pnpm install --frozen-lockfile` - passed; installed pinned workspace dependencies in the isolated worktree after the first API test attempt failed because `vitest` was missing.
- `corepack pnpm api:check` - passed.
- `corepack pnpm web:check` - passed.
- `uv --project workers/automation run python -c "import ast, pathlib; [ast.parse(pathlib.Path(p).read_text()) for p in ['workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py', 'workers/automation/tests/test_projection_builder.py']]"` - passed.
- `corepack pnpm api:test -- projections.test.ts` - passed, 14 files / 251 tests.
- `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_projection_builder.py` - passed, 18 tests.
- `corepack pnpm --filter @jobhunter/web exec vitest run src/views/jobs/JobDetailDrawer.test.tsx` - passed, 1 file / 16 tests. Node emitted its existing localStorage experimental warning.
- `corepack pnpm api:test -- projections.test.ts` after iteration 3 - passed, 14 files / 251 tests.
- `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_projection_builder.py` after iteration 3 - passed, 18 tests.
- `corepack pnpm --filter @jobhunter/web exec vitest run src/views/jobs/JobDetailDrawer.test.tsx` after iteration 3 - passed, 1 file / 16 tests.
- `corepack pnpm api:check` after iteration 3 - passed.
- `corepack pnpm web:check` after iteration 3 - passed.
- `corepack pnpm api:test -- projections.test.ts` after iteration 4 - passed, 14 files / 251 tests.
- `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_projection_builder.py` after iteration 4 - passed, 18 tests.
- `corepack pnpm --filter @jobhunter/web exec vitest run src/views/jobs/JobDetailDrawer.test.tsx` after iteration 4 - passed, 1 file / 16 tests.
- `corepack pnpm api:check` after iteration 4 - passed.
- `corepack pnpm web:check` after iteration 4 - passed.
- `corepack pnpm api:test -- projections.test.ts` after iteration 5 - passed, 14 files / 251 tests.
- `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_projection_builder.py` after iteration 5 - passed, 18 tests.
- `corepack pnpm --filter @jobhunter/web exec vitest run src/views/jobs/JobDetailDrawer.test.tsx` after iteration 5 - passed, 1 file / 16 tests.
- `corepack pnpm api:check` after iteration 5 - passed.
- `corepack pnpm web:check` after iteration 5 - passed.
- `corepack pnpm api:test -- projections.test.ts` after iteration 6 - passed, 14 files / 252 tests.
- `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_projection_builder.py` after iteration 6 - passed, 19 tests.
- `corepack pnpm --filter @jobhunter/web exec vitest run src/views/jobs/JobDetailDrawer.test.tsx` after iteration 6 - passed, 1 file / 17 tests.
- `corepack pnpm --filter @jobhunter/web e2e -- tests/jobs-drawer.spec.ts` after iteration 6 - passed, 4 tests.
- `corepack pnpm api:check` after iteration 6 - passed.
- `corepack pnpm web:check` after iteration 6 - passed.
- `corepack pnpm api:test -- projections.test.ts` after iteration 7 - passed, 14 files / 253 tests.
- `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_projection_builder.py` after iteration 7 - passed, 20 tests.
- `corepack pnpm --filter @jobhunter/web exec vitest run src/views/jobs/JobDetailDrawer.test.tsx` after iteration 7 - passed, 1 file / 18 tests.
- `corepack pnpm --filter @jobhunter/web e2e -- tests/jobs-drawer.spec.ts` after iteration 7 - passed, 4 tests.
- `corepack pnpm api:check` after iteration 7 - passed.
- `corepack pnpm web:check` after iteration 7 - passed.
- `git diff --check` after iteration 7 - passed.
- `corepack pnpm api:test -- projections.test.ts` after iteration 8 - passed, 14 files / 257 tests.
- `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_projection_builder.py` after iteration 8 - passed, 24 tests.
- `corepack pnpm --filter @jobhunter/web exec vitest run src/views/jobs/JobDetailDrawer.test.tsx` after iteration 8 - passed, 1 file / 19 tests.
- `corepack pnpm --filter @jobhunter/web e2e -- tests/jobs-drawer.spec.ts` after iteration 8 - passed, 4 tests.
- `corepack pnpm api:check` after iteration 8 - passed.
- `corepack pnpm web:check` after iteration 8 - passed.
- `git diff --check` after iteration 8 - passed.
- `corepack pnpm api:test -- projections.test.ts` after iteration 9 - passed, 14 files / 258 tests.
- `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_projection_builder.py` after iteration 9 - passed, 25 tests.
- `corepack pnpm --filter @jobhunter/web exec vitest run src/views/jobs/JobDetailDrawer.test.tsx` before iteration 9 source commit - passed, 1 file / 19 tests.
- `corepack pnpm --filter @jobhunter/web e2e -- tests/jobs-drawer.spec.ts` after iteration 9 - passed, 4 tests.
- `corepack pnpm api:check` after iteration 9 - passed.
- `corepack pnpm web:check` after iteration 9 - passed.
- `git diff --check` after iteration 9 - passed.
- `corepack pnpm api:test -- projections.test.ts` after iteration 10 - passed, 14 files / 262 tests.
- `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_projection_builder.py` after iteration 10 - passed, 28 tests.
- `corepack pnpm api:check` after iteration 10 - passed.
- `uv --project workers/automation run python -c "import ast, pathlib; [ast.parse(pathlib.Path(p).read_text()) for p in ['workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py', 'workers/automation/tests/test_projection_builder.py']]"` after iteration 10 - passed.
- `git diff --check` after iteration 10 - passed.
- `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_projection_builder.py` after iteration 11 - passed, 29 tests.
- `uv --project workers/automation run python -c "import ast, pathlib; [ast.parse(pathlib.Path(p).read_text()) for p in ['workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py', 'workers/automation/tests/test_projection_builder.py']]"` after iteration 11 - passed.
- `corepack pnpm api:test -- projections.test.ts` after iteration 11 - passed, 14 files / 262 tests.
- `corepack pnpm api:check` after iteration 11 - passed.
- `git diff --check` after iteration 11 - passed.
- `corepack pnpm api:test -- projections.test.ts` after iteration 12 - passed, 14 files / 265 tests.
- `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_projection_builder.py` after iteration 12 - passed, 32 tests.
- `corepack pnpm api:check` after iteration 12 - passed.
- `uv --project workers/automation run python -c "import ast, pathlib; [ast.parse(pathlib.Path(p).read_text()) for p in ['workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py', 'workers/automation/tests/test_projection_builder.py']]"` after iteration 12 - passed.
- `git diff --check` after iteration 12 - passed.
- `corepack pnpm --filter @jobhunter/web exec vitest run src/contexts/operations/invalidation-router.test.ts` after iteration 13 - passed, 57 tests.
- `corepack pnpm --filter @jobhunter/web e2e -- tests/jobs-drawer.spec.ts` after iteration 13 - passed, 4 tests.
- `corepack pnpm web:check` after iteration 13 - passed.
- `git diff --check` after iteration 13 - passed.
- `corepack pnpm api:test -- projections.test.ts` after iteration 14 - passed, 14 files / 265 tests.
- `corepack pnpm api:check` after iteration 14 - passed.
- `git diff --check` after iteration 14 - passed.
- `corepack pnpm api:test -- projections.test.ts` after iteration 15 - passed, 14 files / 268 tests.
- `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_projection_builder.py` after iteration 15 - passed, 35 tests.
- `corepack pnpm api:check` after iteration 15 - passed.
- `uv --project workers/automation run --extra dev ruff check workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py workers/automation/tests/test_projection_builder.py` after iteration 15 - passed.
- `git diff --check` after iteration 15 - passed.
- `corepack pnpm api:test -- projections.test.ts` after iteration 16 - passed, 14 files / 270 tests.
- `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_projection_builder.py` after iteration 16 - passed, 37 tests.
- `corepack pnpm api:check` after iteration 16 - passed.
- `corepack pnpm --filter @jobhunter/contracts check` after iteration 16 - passed.
- `uv --project workers/automation run --extra dev ruff check workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py workers/automation/tests/test_projection_builder.py` after iteration 16 - passed.
- `git diff --check` after iteration 16 - passed.

---

_Fixed: 2026-06-21T01:41:07Z_
_Fixer: the agent_
_Iteration: 16_
