# Phase 22: Product-Path QA & Safety Release - Pattern Map

**Mapped:** 2026-06-21
**Files analyzed:** 10
**Analogs found:** 10 / 10

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `.planning/phases/22-product-path-qa-safety-release/22-VALIDATION.md` | validation artifact | batch | `.planning/phases/21-jobs-triage-ux-warning-only-floor/21-VERIFICATION.md` | role-match |
| `.planning/phases/22-product-path-qa-safety-release/22-VERIFICATION.md` | verification artifact | batch | `.planning/phases/21-jobs-triage-ux-warning-only-floor/21-VERIFICATION.md` | exact |
| `workers/automation/tests/test_posted_compensation_parser.py` | test | transform | `workers/automation/tests/test_posted_compensation_parser.py` | exact existing file |
| `workers/automation/tests/test_market_compensation_estimator.py` | test | transform | `workers/automation/tests/test_market_compensation_estimator.py` | exact existing file |
| `apps/api/test/projections.test.ts` | test | CRUD / transform | `apps/api/test/projections.test.ts` | exact existing file |
| `apps/api/test/server.test.ts` | test | request-response | `apps/api/test/server.test.ts` | exact existing file |
| `apps/api/test/market-compensation-estimates.test.ts` | test | request-response | `apps/api/test/market-compensation-estimates.test.ts` | role-match |
| `apps/web/src/views/jobs/JobsView.test.tsx` | test | request-response | `apps/web/src/views/jobs/JobsView.test.tsx` | exact existing file |
| `apps/web/src/views/jobs/JobDetailDrawer.test.tsx` | test | request-response | `apps/web/src/views/jobs/JobDetailDrawer.test.tsx` | exact existing file |
| `apps/web/e2e/tests/jobs-drawer.spec.ts` | test | request-response / file-I/O | `apps/web/e2e/tests/jobs-drawer.spec.ts` | exact existing file |
| `docs/local-reliability-qa.md` | documentation | batch | `docs/local-reliability-qa.md` | exact existing file |

## Pattern Assignments

### `.planning/phases/22-product-path-qa-safety-release/22-VALIDATION.md` (validation artifact, batch)

**Analog:** `.planning/phases/21-jobs-triage-ux-warning-only-floor/21-VERIFICATION.md`

**Command evidence pattern** (lines 55-64):
```markdown
| `corepack pnpm web:check` | PASS |
| `corepack pnpm --filter @jobhunter/web exec vitest run src/views/jobs/JobDetailDrawer.test.tsx` | PASS, 19 tests |
| `corepack pnpm --filter @jobhunter/web e2e -- tests/jobs-drawer.spec.ts` | PASS, 4 Playwright tests |
| `git diff --check` | PASS |
| `git status --short` | PASS, clean worktree after QA |
```

**Safety boundary pattern** (lines 66-70):
```markdown
## Safety Boundaries

- QA used synthetic or seeded data.
- No auto-apply, browser submission, mailbox scanning, real external provider scraping, real generated-material regeneration, destructive profile/database action, or worker-backed apply job was run.
- No profile data, resumes, generated PDFs, application logs, SQLite database contents, OAuth data, API keys, or secrets are exposed in this artifact.
```

Apply this to the Phase 22 matrix rows: every QA-01 scenario should name fixture data, owning layer, automated command, command result, and whether manual/browser evidence is required.

### `.planning/phases/22-product-path-qa-safety-release/22-VERIFICATION.md` (verification artifact, batch)

**Analog:** `.planning/phases/21-jobs-triage-ux-warning-only-floor/21-VERIFICATION.md`

**Residual-risk pattern** (lines 72-75):
```markdown
## Residual Risk

- Full `pnpm test` and `web:build` were not rerun after the final market-bound fix. The executed coverage was limited to high-signal Phase 21 API, contracts, Python projection, web typecheck, drawer unit/a11y, and Playwright product-path checks.
- Playwright QA uses synthetic seeded data and stubbed dispatch rather than real user data or provider-backed compensation inputs.
```

For Phase 22, copy the shape but update the command list to the actual release gate results from `22-VALIDATION.md`.

### `workers/automation/tests/test_posted_compensation_parser.py` (test, transform)

**Analog:** `workers/automation/tests/test_posted_compensation_parser.py`

**Imports pattern** (lines 1-3):
```python
from __future__ import annotations

from jobhunter.domain.compensation import SOURCE_TEXT_LIMIT, parse_posted_compensation
```

**Explicit state assertions** (lines 6-24):
```python
def test_missing_salary_returns_missing_state() -> None:
    fact = parse_posted_compensation(None, job_url="job-1", parsed_at="2026-06-19T10:00:00Z")

    assert fact.parse_state == "missing"
    assert fact.confidence == "none"
    assert fact.minimum_amount is None

def test_unparseable_salary_preserves_raw_fallback_and_warning() -> None:
    fact = parse_posted_compensation("Competitive package", job_url="job-1", parsed_at="2026-06-19T10:00:00Z")

    assert fact.parse_state == "unparseable"
    assert fact.legacy_raw_salary == "Competitive package"
    assert "no_amount_found" in fact.warnings
```

**Broad range / ambiguity pattern** (lines 96-107, 123-133):
```python
def test_one_sided_and_broad_ranges_are_warned() -> None:
    one_sided = parse_posted_compensation("Up to €110,000/year", job_url="job-1")
    broad = parse_posted_compensation("€40,000 - €140,000/year", job_url="job-2")

    assert "one_sided_range" in one_sided.warnings
    assert "broad_range" in broad.warnings

def test_bonus_commission_equity_and_ote_warnings_are_visible() -> None:
    ote = parse_posted_compensation("€120k OTE/year", job_url="ote")

    assert ote.component == "ote"
    assert "ote_component" in ote.warnings
```

Use this file for QA-01 parser states: missing, unparseable, broad range, OTE/equity ambiguity, warning visibility, and source text bounding.

### `workers/automation/tests/test_market_compensation_estimator.py` (test, transform)

**Analog:** `workers/automation/tests/test_market_compensation_estimator.py`

**Imports and fixture helpers** (lines 1-31):
```python
from __future__ import annotations

import pytest

from jobhunter.domain.compensation import ReportedCompensationObservation, estimate_market_compensation

def _levels(...) -> ReportedCompensationObservation:
    return ReportedCompensationObservation(
        source_id="levels_fyi",
        company_name=company,
        role_title=role,
        sample_count=sample_count,
        release_year=release_year,
    )
```

**Exact and adjacent fallback pattern** (lines 56-82, 85-98):
```python
def test_estimates_exact_company_role_from_reported_levels_and_glassdoor_rows() -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/platform",
        company="Acme AI Ltd.",
        title="Senior Platform Engineer",
        observations=(_levels(), _glassdoor(role="Senior Platform Engineer")),
    )

    assert estimate.estimate_state == "estimated_range"
    assert estimate.match_scope == "exact_company_role"
    assert {source.source_id for source in estimate.sources} == {"levels_fyi", "glassdoor"}

def test_estimates_company_adjacent_role_with_explicit_fallback_warning() -> None:
    estimate = estimate_market_compensation(...)

    assert estimate.match_scope == "company_adjacent_role"
    assert "company_role_fallback" in estimate.warnings
```

**Weak evidence and conflict pattern** (lines 100-143, 163-189):
```python
def test_company_role_observations_are_required_before_estimating() -> None:
    estimate = estimate_market_compensation(...)

    assert estimate.estimate_state == "insufficient_evidence"
    assert "missing_reported_observation" in estimate.insufficient_reasons

def test_stale_reported_sources_are_source_unavailable() -> None:
    estimate = estimate_market_compensation(observations=(_levels(release_year=2020),))

    assert estimate.estimate_state == "source_unavailable"
    assert "stale_source_snapshot" in estimate.source_unavailable_reasons

@pytest.mark.parametrize(("posted_min", "posted_max", "expected_warning"), [...])
def test_posted_salary_conflict_is_explicit(...) -> None:
    ...
    assert expected_warning in estimate.warnings
```

Add Phase 22 estimator gaps here: trimodal `tier_role_fallback`, `trimodal_tier_inferred`, weak level/location, low sample, high dispersion, and source agreement degradation.

### `apps/api/test/projections.test.ts` (test, CRUD / transform)

**Analog:** `apps/api/test/projections.test.ts`

**Canonical SQLite fixture pattern** (lines 310-370):
```typescript
function insertCompensationRows(dbPath: string, tenantId = "local"): void {
  const db = new Database(dbPath);
  const jobUrl = "https://example.com/jobs/event-driven";
  db.prepare("UPDATE jobs SET salary = ? WHERE url = ?").run("EUR 70000-90000/year", jobUrl);
  db.exec(`
    CREATE TABLE job_posted_compensation_facts (...);
    CREATE TABLE job_market_compensation_estimates (...);
  `);
```

**Projection assertion pattern** (lines 557-630):
```typescript
it("projects canonical compensation summary and detail audit JSON", async () => {
  seedSchema(dbPath);
  insertCompensationRows(dbPath);
  const app = buildApp({ dbPath, settingsPath: path.join(path.dirname(dbPath), "dashboard.json") });
  const res = await app.inject({ method: "GET", url: "/v1/jobs?q=event" });
  expect(res.statusCode, res.body).toBe(200);

  const summary = JSON.parse(listProjection?.compensation_summary_json ?? "{}");
  expect(summary).toMatchObject({
    projectionVersion: 1,
    posted: { recordStatus: "recorded", parseState: "parsed_range" },
    market: { sourceKind: "reported_company_role_market", recordStatus: "recorded" },
  });
  const audit = JSON.parse(detailProjection?.compensation_audit_json ?? "{}");
  expect(audit.market.estimate.matchScope).toBe("exact_company_role");
  expect(JSON.stringify(audit)).not.toContain("/Users/");
});
```

**Warning-only floor pattern** (lines 1051-1118):
```typescript
expect(summary.floorComparison).toMatchObject({
  state: "below_floor",
  basis: "both_posted_and_market",
  warningCount: 1,
  warningLabels: ["posted_compensation_below_profile_floor"],
});
expect(audit.floorComparison).toEqual(summary.floorComparison);
expect(JSON.stringify(audit.floorComparison)).not.toContain("salary_expectation");
expect(JSON.stringify(audit.floorComparison)).not.toContain("/Users/");
```

Use this for QA-04 canonical/parity safety and any Phase 22 persisted visibility rows.

### `apps/api/test/server.test.ts` (test, request-response)

**Analog:** `apps/api/test/server.test.ts`

**Product-path safety test pattern** (lines 1463-1525):
```typescript
it("keeps the compensation boundary from changing fit score, filters, readiness, or apply dispatch", async () => {
  const seedDb = new Database(options.dbPath);
  seedDb.prepare("UPDATE jobs SET salary = ? WHERE url = ?").run("€55,000/year", "https://example.com/jobs/ready");
  insertPostedCompensationFact(seedDb, "https://example.com/jobs/ready");
  insertProfileFloor(seedDb, "75000");

  const list = await app.inject({ method: "GET", url: "/v1/jobs?sort=fit_score&dir=desc&pageSize=3" });
  expect(items.map((job) => job.jobKey)).toEqual([
    "https://example.com/jobs/ready",
    "https://example.com/jobs/failed-score",
    "https://example.com/jobs/blocked-tailor",
  ]);
  expect(JOB_SORT_FIELDS).not.toContain("compensation_floor");
  expect(filtered.json().filter).not.toHaveProperty("compensationFloor");
});
```

**Apply readiness / dry-run dispatch pattern** (lines 1575-1599, 1696-1718):
```typescript
expect(detailBody.applyAudit).toMatchObject({
  state: "preparing",
  label: "materials preparing",
  reviewEvidenceAvailable: true,
});
expect(JSON.stringify(detailBody.applyAudit)).not.toContain("compensation_below_profile_floor");

const apply = await app.inject({ method: "POST", url: `/v1/jobs/${readyKey}/actions/apply`, payload: {} });
expect(apply.statusCode, apply.body).toBe(202);
expect(apply.json()).toMatchObject({ ok: true, action: "apply", command: { dryRun: true } });
expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: "apply", dryRun: true }), expect.anything());
```

**Seed helper pattern** (lines 6091-6143, 6180-6285):
```typescript
function insertPostedCompensationFact(db: Database.Database, jobUrl: string): void {
  db.exec(`CREATE TABLE IF NOT EXISTS job_posted_compensation_facts (...)`);
  db.prepare(`INSERT INTO job_posted_compensation_facts (...) VALUES (...)`).run(
    "local",
    jobUrl,
    "jobs.salary",
    "€55,000/year",
    "parsed_range",
    "EUR",
    "posted-compensation-v1",
  );
}

function insertMarketCompensationEstimate(db: Database.Database, jobUrl: string): void {
  db.exec(`CREATE TABLE IF NOT EXISTS job_market_compensation_estimates (...)`);
  db.prepare(`INSERT INTO job_market_compensation_estimates (...) VALUES (...)`).run(
    "local",
    jobUrl,
    "estimated_range",
    "EUR",
    "reported company-role compensation",
    JSON.stringify([{ source_id: "levels_fyi" }, { source_id: "glassdoor" }]),
  );
}
```

Use this for QA-02 same-job present/weak/unavailable/absent compensation safety comparisons.

### `apps/api/test/market-compensation-estimates.test.ts` (test, request-response)

**Analog:** `apps/api/test/market-compensation-estimates.test.ts`

**API fixture helper pattern:** This file uses temp DB setup, `insertEstimate`, and `app.inject` requests against `/v1/jobs/:jobKey/compensation/market`. Match that style if Phase 22 adds an API-visible trimodal/source-conflict row. Keep source snapshots synthetic and reduce unknown warning handling to explicit contract assertions.

**Relevant references:** file lines 11-31 for temp DB setup, lines 58-76 for market table shape, lines 129-191 for estimate insert helper, lines 212-318 for recorded/unavailable/insufficient API assertions.

### `apps/web/src/views/jobs/JobsView.test.tsx` (test, request-response)

**Analog:** `apps/web/src/views/jobs/JobsView.test.tsx`

**Imports and harness pattern** (lines 1-39):
```typescript
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import type { JobListQuery, JobSummary, Stage } from "@jobhunter/contracts";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jobWithCompensation, makeJobsPage, makeSourceUnavailableCompensationSummary } from "../../test/fixtures/projections.js";
import { buildProviderHarness } from "../../test/render.js";
import { buildTestPorts } from "../../test/testPorts.js";
import { JobsView } from "./JobsView.js";
```

**Compensation columns pattern** (lines 114-145):
```typescript
const jobs = vi.fn(async () =>
  makeJobsPage([
    jobWithCompensation({
      jobKey: "job-comp-high",
      title: "Compensation Scan Role",
      compensationSummary: makeFloorConfiguredCompensationSummary({ warningCount: 2 }),
    }),
  ]),
);
render(<RouterProvider router={router} />, { wrapper: Wrapper });
expect(screen.getByRole("columnheader", { name: "Posted" })).toBeInTheDocument();
expect(screen.getByRole("columnheader", { name: "Market" })).toBeInTheDocument();
expect(screen.getByRole("columnheader", { name: "Warnings" })).toBeInTheDocument();
expect(row.getByText("2 warnings")).toBeInTheDocument();
```

**Display-only safety pattern** (lines 276-299):
```typescript
it("does not expose compensation sorting, filtering, route search, or query fields", async () => {
  ...
  for (const label of ["Posted", "Market", "Warnings"]) {
    expect(screen.queryByRole("button", { name: new RegExp(`sort by ${label}`, "i") })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: new RegExp(`filter ${label} column`, "i") })).not.toBeInTheDocument();
  }
  expect(JSON.stringify(router.state.location.search)).not.toMatch(/compensation|posted|market|warning/i);
  expect(JSON.stringify(jobs.mock.calls[0]?.[0] ?? {})).not.toMatch(/compensation|posted|market|warning/i);
});
```

Use this for QA-05 Jobs list scan states and QA-02 no sorting/filtering/query fields.

### `apps/web/src/views/jobs/JobDetailDrawer.test.tsx` (test, request-response)

**Analog:** `apps/web/src/views/jobs/JobDetailDrawer.test.tsx`

**MSW drawer harness pattern** (lines 57-82, 87-110):
```typescript
function renderJobDetailDrawer(jobId: string) {
  const harness = buildProviderHarness();
  const router = createRouter({
    routeTree: rootRoute.addChildren([jobsRoute.addChildren([detailRoute])]),
    history: createMemoryHistory({
      initialEntries: [`/jobs/${encodeURIComponent(jobId)}?stage=all&state=all&deleted=active&sort=discovered_at&dir=desc&page=1&pageSize=50`],
    }),
  });
  return { router, ...render(<RouterProvider router={router} />, { wrapper: harness.Wrapper }) };
}
```

**Explicit state pattern** (lines 333-399):
```typescript
const details = new Map([
  ["missing-posted", jobDetailWithCompensation(undefined, { compensationAudit: makeCompensationAudit({ posted: makeMissingPostedCompensationAudit() }) })],
  ["unparseable-posted", jobDetailWithCompensation(undefined, { compensationAudit: makeCompensationAudit({ posted: makeUnparseablePostedCompensationAudit() }) })],
  ["insufficient-market", jobDetailWithCompensation(undefined, { compensationAudit: makeCompensationAudit({ market: makeInsufficientMarketCompensationAudit() }) })],
  ["unavailable-market", jobDetailWithCompensation(undefined, { compensationAudit: makeCompensationAudit({ market: makeUnavailableMarketCompensationAudit() }) })],
]);
...
expect(within(compensation).getByText(expectedText)).toBeInTheDocument();
```

**Warning-only boundary pattern** (lines 487-525):
```typescript
expect(within(compensation).getByText("posted_compensation_below_profile_floor")).toBeInTheDocument();
expect(
  within(compensation).getByText("Compensation warnings do not change ranking, filters, apply readiness, blockers, or dispatch in v1.3."),
).toBeInTheDocument();

const triage = screen.getByRole("region", { name: "Why this job is here" });
expect(within(triage).queryByText("posted_compensation_below_profile_floor")).not.toBeInTheDocument();
expect(within(drawer).getByLabelText("Apply readiness")).toHaveTextContent("materials ready");
```

**Drawer ordering pattern** (lines 744-758):
```typescript
const drawer = screen.getByLabelText("Job details");
const sections = Array.from(drawer.querySelectorAll("section.section"));
expect(sections.at(-1)).toHaveTextContent("Audit history");
expect(sections[1]).toHaveTextContent("Compensation audit");
expect(sections[2]).toHaveTextContent("Description");
```

Use this for QA-05 drawer states, source-conflict visibility, and warning labels staying out of Apply concerns/readiness.

### `apps/web/e2e/tests/jobs-drawer.spec.ts` (test, request-response / file-I/O)

**Analog:** `apps/web/e2e/tests/jobs-drawer.spec.ts`

**Seeded disposable DB pattern** (lines 1-18):
```typescript
import Database from "better-sqlite3";
import { test, expect } from "@playwright/test";

const FILTER_PARAMS = "stage=all&state=all&deleted=active&sort=fit_score&dir=desc&page=1&pageSize=50";

test.beforeEach(() => {
  seedSyntheticCompensationData();
});

function seedSyntheticCompensationData(): void {
  const dbPath = process.env["JOBHUNTER_E2E_DB_PATH"];
  if (!dbPath) {
    throw new Error("JOBHUNTER_E2E_DB_PATH is required for Jobs compensation e2e data.");
  }
  const db = new Database(dbPath);
```

**SQLite upsert fixture pattern** (lines 77-122, 123-180):
```typescript
db.prepare("UPDATE jobs SET salary = ? WHERE url = ?").run("€55,000/year", PLATFORM_JOB_URL);
db.prepare(`INSERT INTO job_posted_compensation_facts (...) VALUES (...) ON CONFLICT(tenant_id, job_url) DO UPDATE SET ...`).run(
  "local",
  PLATFORM_JOB_URL,
  "jobs.salary",
  "€55,000/year",
  "parsed_range",
  "EUR",
);
db.prepare(`INSERT INTO job_market_compensation_estimates (...) VALUES (...) ON CONFLICT(tenant_id, job_url) DO UPDATE SET ...`).run(
  "local",
  PLATFORM_JOB_URL,
  "estimated_range",
  "EUR",
  "reported company-role compensation",
  JSON.stringify([{ source_id: "levels_fyi", display_name: "Levels.fyi" }]),
);
```

**Product-path assertion pattern** (lines 267-345):
```typescript
await page.setViewportSize({ width: 390, height: 860 });
await page.goto(`/jobs?${FILTER_PARAMS}`);
const hasHorizontalScroll = await gridScroll.evaluate((element) => element.scrollWidth > element.clientWidth);
expect(hasHorizontalScroll).toBe(true);

for (const header of ["Posted", "Market", "Warnings"]) {
  await expect(page.getByRole("columnheader", { name: header })).toBeVisible();
}
for (const label of ["Posted", "Market", "Warnings"]) {
  await expect(page.getByRole("button", { name: new RegExp(`sort by ${label}`, "i") })).toHaveCount(0);
  await expect(page.getByRole("button", { name: new RegExp(`filter ${label}`, "i") })).toHaveCount(0);
}
await expect(compensation.getByText("Warning-only salary evidence")).toBeVisible();
await expect(drawer.getByLabel("Apply readiness")).not.toContainText(/compensation|salary|floor/i);
```

**Apply Review handoff pattern** (lines 396-412):
```typescript
const response = await page.request.get("/v1/apply/review-queue");
const target = queue.items?.[0];
await page.goto(`/jobs/${encodeURIComponent(target!.jobKey)}?${FILTER_PARAMS}`);
await drawer.getByRole("link", { name: `Open Apply Review for ${target!.title}` }).click();
await expect(page).toHaveURL(/\/apply-review\?/);
```

Use this for seeded browser QA, source-conflict visibility, missing/unavailable states, horizontal scroll, drawer ordering, and handoff evidence. Do not introduce real provider, mailbox, browser submission, material regeneration, or worker-backed apply jobs.

### `docs/local-reliability-qa.md` (documentation, batch)

**Analog:** `docs/local-reliability-qa.md`

**Regression matrix row pattern** (lines 69-72):
```markdown
| Posted compensation parsing loses explicit states, over-captures source text, annualizes without assumptions, mutates `jobs.salary`, writes facts from API GET reads, leaks private data, or changes fit score, sorting, filtering, apply readiness, or apply dispatch behavior | `workers/automation/tests/test_posted_compensation_parser.py`; ... |
| Reported company-role compensation estimates produce precise ranges from weak evidence, ... or change fit score, sorting, filtering, apply readiness, or apply dispatch behavior | `workers/automation/tests/test_market_compensation_estimator.py`; ... |
| Jobs compensation triage collapses separate Posted/Market/Warnings scan columns, hides missing or unavailable states, ... or lets compensation warnings influence sorting, filtering, fit score, apply readiness, blockers, Apply concerns, or dispatch controls | `apps/web/e2e/tests/jobs-drawer.spec.ts`; ... |
```

**Jobs smoke pattern** (lines 241-266):
```markdown
### Jobs Compensation Triage Smoke

For UI changes around compensation scan columns, market estimates, or floor
warnings, use only Playwright-seeded or disposable synthetic app data. Run:

```bash
corepack pnpm --filter @jobhunter/web e2e -- tests/jobs-drawer.spec.ts
corepack pnpm --filter @jobhunter/web test src/views/jobs/JobsView.test.tsx src/views/jobs/JobDetailDrawer.test.tsx src/views/jobs/JobDetailDrawer.a11y.test.tsx
corepack pnpm web:check
corepack pnpm web:build
git diff --check
```

Open `/jobs` with the synthetic compensation fixture and verify desktop plus
narrow/mobile widths.
```

Only update this doc if Phase 22’s release matrix becomes reusable QA procedure. Keep the update narrow.

## Shared Patterns

### Synthetic Data Boundary
**Source:** `.planning/phases/21-jobs-triage-ux-warning-only-floor/21-VERIFICATION.md` lines 66-70 and `docs/local-reliability-qa.md` lines 241-266
**Apply to:** Validation artifact, verification artifact, Playwright spec, docs

Use only synthetic, seeded, or disposable data. Explicitly record that no auto-apply, browser submission, mailbox scanning, real generated-material regeneration, destructive profile/database action, real external scraping/provider access, or worker-backed apply job was run.

### Canonical Compensation Source
**Source:** `apps/api/test/projections.test.ts` lines 310-460 and 557-630
**Apply to:** API projection tests, API market tests, web fixtures

Seed `job_posted_compensation_facts` and `job_market_compensation_estimates` first, refresh/read projections through API paths, and assert Jobs UI claims come from `compensation_summary_json` / `compensation_audit_json`. Do not recompute compensation claims in the frontend.

### Warning-Only Product Boundary
**Source:** `apps/api/test/server.test.ts` lines 1463-1720 and `apps/web/src/views/jobs/JobDetailDrawer.test.tsx` lines 487-525
**Apply to:** API server tests, Jobs view tests, drawer tests, Playwright spec

Assert compensation warnings do not alter fit score order, filters, sort fields, Apply readiness, Apply concerns, blockers, handoff, or apply dispatch. Where an apply action is exercised in API tests, keep dispatch stubbed and assert `dryRun: true`.

### Jobs UI Test Harness
**Source:** `apps/web/src/views/jobs/JobsView.test.tsx` lines 1-64 and `apps/web/src/views/jobs/JobDetailDrawer.test.tsx` lines 57-82
**Apply to:** Jobs list and drawer unit tests

Use TanStack memory router, `buildProviderHarness`, `buildTestPorts` for list data, and MSW `server.use(http.get("*/v1/jobs/:jobKey", ...))` for drawer details. Keep tests colocated and use fixture builders from `apps/web/src/test/fixtures/projections.ts`.

### Playwright Product-Path Smoke
**Source:** `apps/web/e2e/tests/jobs-drawer.spec.ts` lines 1-18 and 267-345
**Apply to:** Browser QA and e2e spec updates

Seed the disposable e2e SQLite DB via `JOBHUNTER_E2E_DB_PATH`, visit `/jobs` with URL-backed filters, assert horizontal scroll at narrow widths, visible Posted/Market/Warnings columns, absence of compensation sort/filter buttons, drawer ordering, source trail/confidence visibility, and Apply readiness not containing compensation language.

## No Analog Found

None. Every likely Phase 22 touch surface has a direct or close existing analog.

## Metadata

**Analog search scope:** `.planning/phases/21-jobs-triage-ux-warning-only-floor`, `workers/automation/tests`, `apps/api/test`, `apps/web/src/views/jobs`, `apps/web/e2e/tests`, `docs/local-reliability-qa.md`
**Files scanned:** 17 candidate files from `rg --files` plus targeted large-file ranges
**Pattern extraction date:** 2026-06-21
