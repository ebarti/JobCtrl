import Database from "better-sqlite3";
import { test, expect, type Locator, type Page } from "@playwright/test";

import { loadE2eDbPath, QA_PLATFORM_JOB_ID } from "../fixtures/e2e-state.js";

const FILTER_PARAMS =
  "stage=all&state=all&deleted=active&sort=fit_score&dir=desc&page=1&pageSize=50";
const PLATFORM_JOB_TITLE = "Director of Platform Engineering";
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
    if (
      PROHIBITED_PRODUCT_PATH_REQUESTS.some((pattern) => pattern.test(pathname))
    ) {
      prohibitedRequests.push(`${request.method()} ${pathname}`);
    }
  });
  return prohibitedRequests;
}

function seedSyntheticCompensationData(): void {
  const dbPath = loadE2eDbPath();
  const db = new Database(dbPath);
  try {
    db.prepare(
      "UPDATE jobs SET salary = ? WHERE tenant_id = ? AND job_id = ?",
    ).run("€55,000/year", "local", QA_PLATFORM_JOB_ID);
    db.prepare(
      `INSERT INTO job_posted_compensation_facts (
        tenant_id, job_id, source_field, source_text, legacy_raw_salary,
        parse_state, currency, period, component, minimum_amount, maximum_amount,
        annualized_minimum_amount, annualized_maximum_amount, annualization_assumption,
        confidence, warnings_json, parser_version, source_hash, parsed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, job_id) DO UPDATE SET
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
      QA_PLATFORM_JOB_ID,
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
        tenant_id, job_id, estimate_state, currency, period, component,
        minimum_amount, maximum_amount, confidence_band, confidence_score,
        source_count, sample_count, aggregate_bucket, geography_scope,
        occupation_code, occupation_label, seniority_label, source_snapshot_json,
        factor_reasons_json, selected_evidence_json, insufficient_reasons_json, unsupported_reasons_json,
        source_unavailable_reasons_json, warnings_json, estimator_version, estimated_at,
        company_name, normalized_company, role_title, normalized_role, company_tier, match_scope
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, job_id) DO UPDATE SET
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
        selected_evidence_json = excluded.selected_evidence_json,
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
      QA_PLATFORM_JOB_ID,
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
      JSON.stringify([
        {
          source_id: "levels_fyi",
          source_url:
            "https://www.levels.fyi/companies/gitlab/salaries/software-engineer",
          company_name: "GitLab",
          role_title: "Director of Platform Engineering",
          location: "Europe",
          level_label: "director",
          company_tier: "tier_2_ambitious",
          component: "total_compensation",
          currency: "EUR",
          period: "year",
          minimum_amount: 112_000,
          maximum_amount: 138_000,
          sample_count: 4,
          release_year: 2026,
          company_score: 1,
          role_score: 0.96,
          level_score: 0.95,
          location_score: 0.78,
          freshness_score: 0.95,
        },
        {
          source_id: "glassdoor",
          source_url:
            "https://www.glassdoor.com/Salary/GitLab-Engineering-Director-Salaries-E1296544.htm",
          company_name: "GitLab",
          role_title: "Engineering Director",
          location: "Europe",
          level_label: "director",
          company_tier: "tier_2_ambitious",
          component: "total_compensation",
          currency: "EUR",
          period: "year",
          minimum_amount: 118_000,
          maximum_amount: 142_000,
          sample_count: 3,
          release_year: 2026,
          company_score: 1,
          role_score: 0.92,
          level_score: 0.95,
          location_score: 0.78,
          freshness_score: 0.95,
        },
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
      `INSERT INTO job_events (
         tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json
       ) VALUES ('local', NULL, 1, ?, ?, ?, ?, ?, ?)`,
    ).run(
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
      `INSERT INTO job_events (
         tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json
       ) VALUES ('local', ?, 1, ?, ?, ?, ?, ?, ?)`,
    ).run(
      QA_PLATFORM_JOB_ID,
      "compensation",
      "CompensationFactsUpdated",
      "info",
      "Synthetic e2e compensation facts updated",
      compensationUpdatedAt,
      JSON.stringify({
        tenantId: "local",
        jobId: QA_PLATFORM_JOB_ID,
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

  const jobsList = page.getByRole("list", { name: "Jobs" });
  await expect(jobsList).toBeVisible({ timeout: 30_000 });
  const responsiveLayout = await jobsList.evaluate((element) => ({
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    listClientWidth: element.clientWidth,
    listScrollWidth: element.scrollWidth,
  }));
  expect(
    responsiveLayout.documentScrollWidth,
    "mobile Jobs should not create document-level horizontal overflow",
  ).toBeLessThanOrEqual(responsiveLayout.documentClientWidth + 1);
  expect(
    responsiveLayout.listScrollWidth,
    "mobile Jobs should reflow rather than require horizontal list scrolling",
  ).toBeLessThanOrEqual(responsiveLayout.listClientWidth + 1);
  await page.getByRole("button", { name: "Configure table columns" }).click();
  const columnDialog = page.getByRole("dialog", { name: "Columns" });
  const warningsColumn = columnDialog.getByRole("checkbox", {
    name: "Warnings",
  });
  await expect(warningsColumn).not.toBeChecked();
  await warningsColumn.check();
  await page.keyboard.press("Escape");
  await expect(columnDialog).toHaveCount(0);

  const mobileColumnControls = page.locator(
    "details.data-grid-mobile-controls",
  );
  await expect(mobileColumnControls).toBeVisible();
  await mobileColumnControls.locator("summary").click();
  await expect(mobileColumnControls).toHaveAttribute("open", "");
  for (const label of [
    "Salary min (€ / year)",
    "Salary max (€ / year)",
    "Market (€ / year)",
    "Confidence",
    "Warnings",
  ]) {
    await expect(
      mobileColumnControls.getByRole("button", { name: `Sort by ${label}` }),
    ).toBeVisible();
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
    "expanded mobile column controls should remain inside the viewport",
  ).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth + 1),
  );

  const row = jobsList
    .locator(".data-grid-mobile-record")
    .filter({ hasText: PLATFORM_JOB_TITLE });
  await expect(row).toBeVisible();
  await expect(row.getByText("GitLab", { exact: true })).toBeVisible();
  await expect(row.getByLabel("Job status")).toBeVisible();
  await row
    .getByRole("button", {
      name: /^Open job Director of Platform Engineering at GitLab$/,
    })
    .click();

  const drawer = page.getByRole("article", { name: "Job details" });
  await expect(drawer).toBeVisible({ timeout: 10_000 });

  const compensation = drawer.getByRole("region", {
    name: "Compensation evidence",
  });
  const triage = drawer.getByRole("region", { name: "Job audit triage" });
  const description = drawer.locator("section.job-detail-description");
  await expectRegionBefore(triage, compensation, "triage before compensation");
  await expectRegionBefore(
    compensation,
    description,
    "compensation before description",
  );

  await expect(
    compensation.getByRole("heading", { name: "Compensation" }),
  ).toBeVisible();
  await expect(compensation.getByText("EUR 55000/year").first()).toBeVisible();
  await expect(
    compensation.getByText("EUR 112000-142000/year").first(),
  ).toBeVisible();
  await expect(compensation.getByText("Market salary estimate")).toBeVisible();
  await expect(compensation.getByText(/medium reliability/i)).toBeVisible();
  await expect(compensation.getByText("Evidence reviewed")).toBeVisible();
  await expect(compensation.getByText("How this was assessed")).toBeVisible();
  await compensation.getByText("Evidence reviewed").click();
  await compensation.getByText("How this was assessed").click();
  await expect(
    compensation.getByText(
      "Reported compensation diverges materially from the posted salary.",
    ),
  ).toBeVisible();
  await expect(
    compensation.getByText(
      "The estimate uses reported compensation rows for the job company and role.",
    ),
  ).toBeVisible();
  await expect(compensation.getByText("Reported source trail")).toBeVisible();
  await expect(compensation.getByText("Levels.fyi").first()).toBeVisible();
  await expect(compensation.getByText("Glassdoor").first()).toBeVisible();
  await expect(compensation.getByText("Reliability factors")).toBeVisible();
  await expect(
    compensation.getByText("Observation JSON path (optional)"),
  ).toHaveCount(0);

  await expect(triage.getByText("reported_compensation_sample")).toHaveCount(0);
  await expect(
    triage.getByText("source_conflict_with_posted_salary"),
  ).toHaveCount(0);
  await expect(
    triage.getByText(
      "Reported compensation diverges materially from the posted salary.",
    ),
  ).toHaveCount(0);
  await expect(drawer.getByLabel("Apply readiness")).not.toContainText(
    /compensation|salary|source conflict/i,
  );
  await expect(drawer.getByText("Fit score").first()).toBeVisible();
  expect(prohibitedRequests).toEqual([]);
});

test("Job detail: keyboard activation opens requirement fit, stages, and artifacts; reload and back preserve the URL filter", async ({
  page,
}) => {
  const prohibitedRequests = watchProhibitedProductPathRequests(page);
  await page.goto(`/jobs?${FILTER_PARAMS}`);
  const row = page
    .locator("table.jobs-data-grid-table tbody tr")
    .filter({ hasText: "Director of Platform Engineering" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  const keyboardActivation = row.getByRole("button", {
    name: /^Open job Director of Platform Engineering/,
  });
  await keyboardActivation.focus();
  await expect(keyboardActivation).toBeFocused();
  await expect(keyboardActivation).toBeVisible();
  await keyboardActivation.press("Enter");

  await expect(page).toHaveURL(/\/jobs\/.+/);
  const drawer = page.getByRole("article", { name: "Job details" });
  await expect(drawer).toBeVisible({ timeout: 10_000 });
  await expect(
    drawer.getByRole("heading", { name: /Preparation diagnostics/i }),
  ).toBeVisible();
  await expect(
    drawer.getByRole("heading", { name: /Active artifacts/i }),
  ).toBeVisible();
  const roleAnalysis = drawer.getByRole("region", { name: "Role Analysis" });
  await expect(roleAnalysis).toBeVisible();
  await expect(
    roleAnalysis.getByRole("heading", { name: /Requirements \(2\)/i }),
  ).toBeVisible();
  const primaryRequirement = roleAnalysis.getByLabel(
    "Requirement: Lead platform reliability improvements across critical services.",
  );
  await expect(primaryRequirement).toBeVisible();
  await expect(primaryRequirement).toContainText("Requirement fit");
  await expect(primaryRequirement).toContainText("matched");
  await expect(primaryRequirement).toContainText("Score contribution");
  await expect(primaryRequirement).toContainText("Double Down");

  await page.reload();
  await expect(page.getByRole("article", { name: "Job details" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page).toHaveURL(/sort=fit_score/);

  const backButton = page.getByRole("button", { name: "Back to jobs" });
  await backButton.click();
  await expect(page.getByRole("article", { name: "Job details" })).toHaveCount(
    0,
  );
  await expect(page).toHaveURL(/sort=fit_score/);
  await expect(page).toHaveURL(/\/jobs\?/);
  expect(prohibitedRequests).toEqual([]);
});

test("Job detail: Apply Review handoff preserves the selected job", async ({
  page,
}) => {
  const prohibitedRequests = watchProhibitedProductPathRequests(page);

  const response = await page.request.get("/v1/apply/review-queue");
  expect(response.ok()).toBeTruthy();
  const queue = (await response.json()) as {
    readonly items?: readonly {
      readonly jobKey: string;
      readonly title: string;
    }[];
  };
  const target = queue.items?.[0];
  expect(target, "seeded review queue should contain an item").toBeTruthy();

  await page.goto(
    `/jobs/${encodeURIComponent(target!.jobKey)}?${FILTER_PARAMS}`,
  );
  const drawer = page.getByRole("article", { name: "Job details" });
  await expect(drawer).toBeVisible({ timeout: 30_000 });

  await drawer
    .getByRole("link", { name: `Open Apply Review for ${target!.title}` })
    .click();

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

test("keeps the job detail header Tab order aligned with its visual order", async ({
  page,
}) => {
  // The desktop header grid paints Back + actions on row one and the
  // overview on row two; this asserts the Tab sequence matches it.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/jobs?${FILTER_PARAMS}`);
  const row = page
    .locator("table.jobs-data-grid-table tbody tr")
    .filter({ hasText: PLATFORM_JOB_TITLE });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row
    .getByRole("button", { name: /^Open job Director of Platform Engineering/ })
    .press("Enter");
  const drawer = page.getByRole("article", { name: "Job details" });
  await expect(drawer).toBeVisible({ timeout: 10_000 });

  // The header paints Back + actions on the top row and the overview (with
  // the posting link) below; the Tab sequence must follow the same order.
  await drawer.getByRole("button", { name: "Back to jobs" }).focus();
  await page.keyboard.press("Tab");
  await expect(
    drawer.getByRole("link", { name: /^Open Apply Review for/ }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    drawer.getByRole("link", { name: /^Open evidence map for/ }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    drawer.getByRole("button", { name: "More job actions" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    drawer.getByRole("link", { name: "Open original posting" }),
  ).toBeFocused();
});
