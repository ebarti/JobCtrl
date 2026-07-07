import Database from "better-sqlite3";
import { test, expect, type Locator, type Page } from "@playwright/test";

const FILTER_PARAMS = "stage=all&state=all&deleted=active&sort=fit_score&dir=desc&page=1&pageSize=50";
const PLATFORM_JOB_TITLE = "Director of Platform Engineering";
const PLATFORM_JOB_URL = "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director";
// Pending-preparation pickup is an existing non-apply Jobs behavior; Phase 22 blocks apply/material/Gmail/destructive paths.
const PROHIBITED_PRODUCT_PATH_REQUESTS = [
  /\/v1\/jobs\/.+\/actions\/apply$/i,
  /\/v1\/jobs\/.+\/actions\/generate-materials$/i,
  /\/v1\/jobs\/.+\/actions\/generate-interview-prep$/i,
  /\/v1\/jobs\/.+\/actions\/tailor$/i,
  /\/v1\/jobs\/.+\/actions\/retailor-current-policy$/i,
  /\/v1\/jobs\/.+\/actions\/run-stage$/i,
  /\/v1\/jobs\/.+\/actions\/retry-stage$/i,
  /\/v1\/jobs\/bulk-(?:delete|delete-permanent|restore|hide|unhide|retry-failed)$/i,
  /\/v1\/pipeline\/actions\/run-stage$/i,
  /\/v1\/materials\/actions\/retailor-current-policy$/i,
  /\/v1\/outcomes\/gmail\/scan$/i,
  /\/v1\/profile\/import-resume$/i,
  /\/v1\/_internal\/rpc$/i,
] as const;

test.beforeEach(() => {
  seedSyntheticCompensationData();
});

function watchProhibitedProductPathRequests(page: Page): string[] {
  const prohibitedRequests: string[] = [];
  page.on("request", (request) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method())) return;
    const pathname = new URL(request.url()).pathname;
    if (PROHIBITED_PRODUCT_PATH_REQUESTS.some((pattern) => pattern.test(pathname))) {
      prohibitedRequests.push(`${request.method()} ${pathname}`);
    }
  });
  return prohibitedRequests;
}

function seedSyntheticCompensationData(): void {
  const dbPath = process.env["JOBCTL_E2E_DB_PATH"];
  if (!dbPath) {
    throw new Error("JOBCTL_E2E_DB_PATH is required for Jobs compensation e2e data.");
  }
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS job_posted_compensation_facts (
        tenant_id TEXT NOT NULL DEFAULT 'local',
        job_url TEXT NOT NULL,
        source_field TEXT NOT NULL DEFAULT 'jobs.salary',
        source_text TEXT,
        legacy_raw_salary TEXT,
        parse_state TEXT NOT NULL,
        currency TEXT,
        period TEXT NOT NULL DEFAULT 'unknown',
        component TEXT NOT NULL DEFAULT 'unknown',
        minimum_amount INTEGER,
        maximum_amount INTEGER,
        annualized_minimum_amount INTEGER,
        annualized_maximum_amount INTEGER,
        annualization_assumption TEXT,
        confidence TEXT NOT NULL DEFAULT 'none',
        warnings_json TEXT NOT NULL DEFAULT '[]',
        parser_version TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        parsed_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, job_url)
      );
      CREATE TABLE IF NOT EXISTS job_market_compensation_estimates (
        tenant_id TEXT NOT NULL DEFAULT 'local',
        job_url TEXT NOT NULL,
        estimate_state TEXT NOT NULL,
        currency TEXT,
        period TEXT NOT NULL DEFAULT 'year',
        component TEXT NOT NULL DEFAULT 'total_compensation',
        minimum_amount INTEGER,
        maximum_amount INTEGER,
        confidence_band TEXT NOT NULL DEFAULT 'none',
        confidence_score REAL NOT NULL DEFAULT 0,
        source_count INTEGER NOT NULL DEFAULT 0,
        sample_count INTEGER,
        aggregate_bucket TEXT,
        geography_scope TEXT,
        occupation_code TEXT,
        occupation_label TEXT,
        seniority_label TEXT,
        source_snapshot_json TEXT NOT NULL DEFAULT '[]',
        factor_reasons_json TEXT NOT NULL DEFAULT '[]',
        insufficient_reasons_json TEXT NOT NULL DEFAULT '[]',
        unsupported_reasons_json TEXT NOT NULL DEFAULT '[]',
        source_unavailable_reasons_json TEXT NOT NULL DEFAULT '[]',
        warnings_json TEXT NOT NULL DEFAULT '[]',
        estimator_version TEXT NOT NULL,
        estimated_at TEXT NOT NULL,
        company_name TEXT,
        normalized_company TEXT,
        role_title TEXT,
        normalized_role TEXT,
        company_tier TEXT NOT NULL DEFAULT 'unknown',
        match_scope TEXT NOT NULL DEFAULT 'none',
        PRIMARY KEY (tenant_id, job_url)
      );
    `);
    db.prepare("UPDATE jobs SET salary = ? WHERE url = ?").run("€55,000/year", PLATFORM_JOB_URL);
    db.prepare(
      `INSERT INTO job_posted_compensation_facts (
        tenant_id, job_url, source_field, source_text, legacy_raw_salary,
        parse_state, currency, period, component, minimum_amount, maximum_amount,
        annualized_minimum_amount, annualized_maximum_amount, annualization_assumption,
        confidence, warnings_json, parser_version, source_hash, parsed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, job_url) DO UPDATE SET
        source_text = excluded.source_text,
        legacy_raw_salary = excluded.legacy_raw_salary,
        parse_state = excluded.parse_state,
        currency = excluded.currency,
        period = excluded.period,
        component = excluded.component,
        minimum_amount = excluded.minimum_amount,
        maximum_amount = excluded.maximum_amount,
        annualized_minimum_amount = excluded.annualized_minimum_amount,
        annualized_maximum_amount = excluded.annualized_maximum_amount,
        annualization_assumption = excluded.annualization_assumption,
        confidence = excluded.confidence,
        warnings_json = excluded.warnings_json,
        parser_version = excluded.parser_version,
        source_hash = excluded.source_hash,
        parsed_at = excluded.parsed_at`,
    ).run(
      "local",
      PLATFORM_JOB_URL,
      "jobs.salary",
      "€55,000/year",
      "€55,000/year",
      "parsed_range",
      "EUR",
      "year",
      "base_salary",
      55_000,
      55_000,
      55_000,
      55_000,
      "Source text states annual compensation.",
      "high",
      "[]",
      "posted-compensation-v1",
      "e2e".padEnd(64, "0"),
      "2026-06-19T10:00:00Z",
    );
    db.prepare(
      `INSERT INTO job_market_compensation_estimates (
        tenant_id, job_url, estimate_state, currency, period, component,
        minimum_amount, maximum_amount, confidence_band, confidence_score,
        source_count, sample_count, aggregate_bucket, geography_scope,
        occupation_code, occupation_label, seniority_label, source_snapshot_json,
        factor_reasons_json, insufficient_reasons_json, unsupported_reasons_json,
        source_unavailable_reasons_json, warnings_json, estimator_version, estimated_at,
        company_name, normalized_company, role_title, normalized_role, company_tier, match_scope
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, job_url) DO UPDATE SET
        estimate_state = excluded.estimate_state,
        currency = excluded.currency,
        period = excluded.period,
        component = excluded.component,
        minimum_amount = excluded.minimum_amount,
        maximum_amount = excluded.maximum_amount,
        confidence_band = excluded.confidence_band,
        confidence_score = excluded.confidence_score,
        source_count = excluded.source_count,
        sample_count = excluded.sample_count,
        aggregate_bucket = excluded.aggregate_bucket,
        geography_scope = excluded.geography_scope,
        source_snapshot_json = excluded.source_snapshot_json,
        factor_reasons_json = excluded.factor_reasons_json,
        warnings_json = excluded.warnings_json,
        estimator_version = excluded.estimator_version,
        estimated_at = excluded.estimated_at,
        company_name = excluded.company_name,
        normalized_company = excluded.normalized_company,
        role_title = excluded.role_title,
        normalized_role = excluded.normalized_role,
        company_tier = excluded.company_tier,
        match_scope = excluded.match_scope`,
    ).run(
      "local",
      PLATFORM_JOB_URL,
      "estimated_range",
      "EUR",
      "year",
      "total_compensation",
      112_000,
      142_000,
      "medium",
      0.82,
      2,
      7,
      "reported company-role compensation",
      "Europe",
      "example",
      "platform engineer",
      "senior",
      JSON.stringify([
        {
          source_id: "levels_fyi",
          display_name: "Levels.fyi",
          source_type: "reported_compensation",
          release_year: 2026,
          snapshot_version: "reported-compensation-import-v1",
          geography_scope: "Europe",
          aggregate_bucket: "reported company-role compensation",
          attribution: "Levels.fyi reported compensation data",
          sample_count: 4,
        },
        {
          source_id: "glassdoor",
          display_name: "Glassdoor",
          source_type: "reported_compensation",
          release_year: 2026,
          snapshot_version: "reported-compensation-import-v1",
          geography_scope: "Europe",
          aggregate_bucket: "reported company-role compensation",
          attribution: "Glassdoor reported compensation data",
          sample_count: 3,
        },
      ]),
      JSON.stringify([
        { name: "company", score: 1, band: "high", reason: "Company matched." },
        { name: "role", score: 1, band: "high", reason: "Role matched." },
      ]),
      "[]",
      "[]",
      "[]",
      JSON.stringify([
        "reported_compensation_sample",
        "source_conflict_with_posted_salary",
      ]),
      "company-role-reported-compensation-v1",
      "2026-06-19T10:00:00Z",
      "Greenhouse",
      "greenhouse",
      "Director of Platform Engineering",
      "director platform engineering",
      "tier_2_ambitious",
      "exact_company_role",
    );
    const profileUpdatedAt = "2026-06-19T10:02:00Z";
    db.prepare(
      `UPDATE candidate_profiles
         SET compensation_salary_currency = ?,
             compensation_salary_range_min = ?,
             updated_at = ?
       WHERE tenant_id = ? AND profile_id = ?`,
    ).run("EUR", "75000", profileUpdatedAt, "local", "default");
    db.prepare(
      `INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      null,
      "profile",
      "ProfileUpdated",
      "info",
      "Synthetic e2e profile floor updated",
      profileUpdatedAt,
      JSON.stringify({
        tenantId: "local",
        changedSections: ["profile"],
        updatedAt: profileUpdatedAt,
      }),
    );
    const compensationUpdatedAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      PLATFORM_JOB_URL,
      "compensation",
      "CompensationFactsUpdated",
      "info",
      "Synthetic e2e compensation facts updated",
      compensationUpdatedAt,
      JSON.stringify({
        tenantId: "local",
        jobId: PLATFORM_JOB_URL,
        changedSections: ["posted", "market"],
        postedRecordStatus: "recorded",
        postedParseState: "parsed_range",
        marketRecordStatus: "recorded",
        marketEstimateState: "estimated_range",
        updatedAt: compensationUpdatedAt,
      }),
    );
  } finally {
    db.close();
  }
}

async function expectRegionBefore(
  before: Locator,
  after: Locator,
  label: string,
): Promise<void> {
  await expect(before, `${label} first region`).toBeVisible();
  await expect(after, `${label} second region`).toBeVisible();
  const beforeBox = await before.boundingBox();
  const afterBox = await after.boundingBox();
  expect(beforeBox, `${label} first region box`).not.toBeNull();
  expect(afterBox, `${label} second region box`).not.toBeNull();
  expect(beforeBox!.y, `${label} vertical order`).toBeLessThan(afterBox!.y);
}

test("Jobs compensation source-conflict evidence stays product-visible without unsafe actions", async ({
  page,
}) => {
  const prohibitedRequests = watchProhibitedProductPathRequests(page);
  await page.setViewportSize({ width: 390, height: 860 });
  await page.goto(`/jobs?${FILTER_PARAMS}`);

  const gridScroll = page.locator(".filterable-data-grid-scroll");
  await expect(gridScroll).toBeVisible({ timeout: 30_000 });
  const hasHorizontalScroll = await gridScroll.evaluate(
    (element) => element.scrollWidth > element.clientWidth,
  );
  expect(hasHorizontalScroll).toBe(true);
  for (const label of [
    "Salary min (€ / year)",
    "Salary max (€ / year)",
    "Market (€ / year)",
    "Confidence",
    "Warnings",
  ]) {
    await expect(page.getByRole("button", { name: `Sort by ${label}` })).toBeVisible();
  }

  const row = page
    .locator("table.jobs-data-grid-table tbody tr")
    .filter({ hasText: PLATFORM_JOB_TITLE });
  await expect(row).toBeVisible();
  await expect(row.getByText("55,000").first()).toBeVisible();
  await expect(row.getByText("112,000-142,000").first()).toBeVisible();
  await expect(row.getByText("CI 112,000-142,000")).toBeVisible();
  await expect(row.getByText("Medium")).toBeVisible();
  await expect(row.getByText("82%")).toBeVisible();
  await expect(row.getByText(/2 sources/i)).toBeVisible();
  await expect(row.getByText("2 warnings")).toBeVisible();

  await row
    .getByRole("button", { name: /^Open job Director of Platform Engineering/ })
    .click();

  const drawer = page.getByRole("dialog", { name: "Job details" });
  await expect(drawer).toBeVisible({ timeout: 10_000 });

  const compensation = drawer.getByRole("region", { name: "Compensation evidence" });
  const triage = drawer.getByRole("region", { name: "Job audit triage" });
  const description = drawer.locator("section.job-detail-description");
  await expectRegionBefore(triage, compensation, "triage before compensation");
  await expectRegionBefore(compensation, description, "compensation before description");

  await expect(compensation.getByRole("heading", { name: "Compensation" })).toBeVisible();
  await expect(compensation.getByText("EUR 55000/year").first()).toBeVisible();
  await expect(compensation.getByText("EUR 112000-142000/year").first()).toBeVisible();
  await expect(compensation.getByText("reported_compensation_sample")).toBeVisible();
  await expect(compensation.getByText("source_conflict_with_posted_salary")).toBeVisible();
  await expect(
    compensation.getByText("Reported compensation diverges materially from the posted salary."),
  ).toBeVisible();
  await expect(
    compensation.getByText("The estimate uses reported compensation rows for the job company and role."),
  ).toBeVisible();
  await expect(compensation.getByText("Reported source trail")).toBeVisible();
  await expect(compensation.getByText("Levels.fyi").first()).toBeVisible();
  await expect(compensation.getByText("Glassdoor").first()).toBeVisible();
  await expect(compensation.getByText("Confidence factors")).toBeVisible();

  await expect(triage.getByText("reported_compensation_sample")).toHaveCount(0);
  await expect(triage.getByText("source_conflict_with_posted_salary")).toHaveCount(0);
  await expect(triage.getByText("Reported compensation diverges materially from the posted salary.")).toHaveCount(0);
  await expect(drawer.getByLabel("Apply readiness")).not.toContainText(/compensation|salary|source conflict/i);
  await expect(drawer.getByText("Fit score").first()).toBeVisible();
  expect(prohibitedRequests).toEqual([]);
});

test("Job drawer: opens with requirement fit, stages, artifacts, survives reload, close preserves the URL filter", async ({
  page,
}) => {
  const prohibitedRequests = watchProhibitedProductPathRequests(page);
  await page.goto(`/jobs?${FILTER_PARAMS}`);
  const row = page
    .locator("table.jobs-data-grid-table tbody tr")
    .filter({ hasText: "Director of Platform Engineering" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  // Row activation is the named per-row "Open" button, not a whole-row click:
  // structural rows stay non-interactive for accessibility.
  await row
    .getByRole("button", { name: /^Open job Director of Platform Engineering/ })
    .click();

  await expect(page).toHaveURL(/\/jobs\/.+/);
  const drawer = page.getByRole("dialog", { name: "Job details" });
  await expect(drawer).toBeVisible({ timeout: 10_000 });
  await expect(drawer.getByRole("heading", { name: /Preparation diagnostics/i })).toBeVisible();
  await expect(drawer.getByRole("heading", { name: /Active artifacts/i })).toBeVisible();
  const roleAnalysis = drawer.getByRole("region", { name: "Role Analysis" });
  await expect(roleAnalysis).toBeVisible();
  await expect(roleAnalysis.getByRole("heading", { name: /Requirements \(2\)/i })).toBeVisible();
  const primaryRequirement = roleAnalysis.getByLabel(
    "Requirement: Lead platform reliability improvements across critical services.",
  );
  await expect(primaryRequirement).toBeVisible();
  await expect(primaryRequirement).toContainText("Requirement fit");
  await expect(primaryRequirement).toContainText("matched");
  await expect(primaryRequirement).toContainText("Score contribution");
  await expect(primaryRequirement).toContainText("Double Down");

  await page.reload();
  await expect(page.getByRole("dialog", { name: "Job details" })).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/sort=fit_score/);

  const closeButton = page.getByRole("button", { name: /close job details/i });
  await closeButton.click();
  await expect(page.getByRole("dialog", { name: "Job details" })).toHaveCount(0);
  await expect(page).toHaveURL(/sort=fit_score/);
  await expect(page).toHaveURL(/\/jobs\?/);
  expect(prohibitedRequests).toEqual([]);
});

test("Job drawer: Apply Review handoff preserves the selected job", async ({ page }) => {
  const prohibitedRequests = watchProhibitedProductPathRequests(page);

  const response = await page.request.get("/v1/apply/review-queue");
  expect(response.ok()).toBeTruthy();
  const queue = (await response.json()) as {
    readonly items?: readonly { readonly jobKey: string; readonly title: string }[];
  };
  const target = queue.items?.[0];
  expect(target, "seeded review queue should contain an item").toBeTruthy();

  await page.goto(`/jobs/${encodeURIComponent(target!.jobKey)}?${FILTER_PARAMS}`);
  const drawer = page.getByRole("dialog", { name: "Job details" });
  await expect(drawer).toBeVisible({ timeout: 30_000 });

  await drawer.getByRole("link", { name: `Open Apply Review for ${target!.title}` }).click();

  await expect(page).toHaveURL(/\/apply-review\?/);
  const applyReviewUrl = new URL(page.url());
  expect(applyReviewUrl.searchParams.get("jobKey")).toBe(target!.jobKey);
  expect([...applyReviewUrl.searchParams.keys()]).toEqual(["jobKey"]);
  await expect(
    page.getByRole("region", { name: `Review evidence for ${target!.title}` }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page
      .getByRole("complementary", { name: "Application review queue" })
      .getByRole("button", { name: new RegExp(target!.title) }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(prohibitedRequests).toEqual([]);
});
