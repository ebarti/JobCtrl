import { link, lstat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { APIRequestContext, Locator, Page, Response } from "@playwright/test";

import {
  test,
  expect,
  json,
  action,
  completed,
  modelCall,
  terminal,
  type ApplicationStack,
} from "../harness/fixtures.js";
import { acceptBaseline, createBaseline, current, qualifyPosting, type Posting } from "./core-data.js";

type Job = Posting & {
  title: string;
  hidden: boolean;
  deleted: boolean;
  state_revision: number;
};
type Query = {
  total: number;
  query_revision: string;
  rows: { job: Job; scalars: Record<string, string | number | null> }[];
  facets: Record<string, { values: string[]; complete: boolean }>;
  modules: Record<string, { enabled: boolean; available: boolean }>;
};

const targetTitle = "Synthetic Senior Global Fit Engineer";
const targetCompany = "Synthetic Grid Target Company";
const targetLocation = "Madrid, Spain";

async function columnFilter(page: Page, id: string, label: string): Promise<Locator> {
  await page.getByRole("combobox", { name: "Filter a column", exact: true }).selectOption(id);
  const dialog = page.getByRole("dialog", { name: `${label} filter`, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function applyColumnFilter(page: Page, dialog: Locator) {
  await dialog.getByRole("button", { name: "Apply filters", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
}

async function capture(api: APIRequestContext, slug: string, title: string) {
  return json<Job>(api, "post", "/v1/jobs/capture", {
    url: `https://example.com/jobs/${slug}`,
    title,
    company: title === targetTitle ? targetCompany : "Synthetic Grid Company",
    location: targetLocation,
    description: "Implement and maintain durable workflow recovery.",
    ...(title === targetTitle
      ? { salary: "Base salary EUR 80000 to EUR 100000 per year." }
      : {}),
  });
}

async function recordCompensation(
  api: APIRequestContext,
  app: ApplicationStack,
  job: Posting,
) {
  // An authored report is ingested through the public source adapter. It is
  // neither a database seed nor a replay of a previous model determination.
  const report = path.join(app.workspace, "jobs-query-compensation.json");
  await writeFile(
    report,
    JSON.stringify([
      {
        source: "manual",
        company: targetCompany,
        role: targetTitle,
        location: targetLocation,
        level: "senior",
        currency: "EUR",
        period: "year",
        component: "total_compensation",
        min: 85000,
        max: 110000,
        sampleCount: 5,
        releaseYear: 2026,
        attribution: "Authored synthetic Jobs query report",
      },
    ]),
  );
  const run = await action(api, "compensation.refresh", {
    jobId: job.job_id,
    observationsJsonPath: report,
    includeEuroTopTech: false,
  });
  const posted = await modelCall(app, "compensation.posted_pay");
  const source = (
    posted.body["sources"] as { source_id: string; text: string }[]
  )[0]!;
  expect(source.text).toBe("Base salary EUR 80000 to EUR 100000 per year.");
  posted.reply({
    parse_state: "parsed_range",
    currency: "EUR",
    period: "year",
    component: "base_salary",
    minimum_amount: 80000,
    maximum_amount: 100000,
    confidence: "high",
    warnings: [],
    citations: [{ source_id: source.source_id, quote: source.text }],
    rationale: "The selected posting states this annual base range.",
  });
  for (const kind of ["posting", "report"] as const) {
    const call = await modelCall(app, "compensation.classification");
    const actual = (
      call.body["sources"] as { source_id: string; text: string }[]
    )[0]!;
    expect(actual.source_id).toContain(
      kind === "posting"
        ? `posting:${job.job_id}`
        : "manual_reported_compensation:",
    );
    const judgment = (value: string, quote: string) => {
      expect(actual.text).toContain(quote);
      return {
        value,
        citations: [{ source_id: actual.source_id, quote }],
        rationale: "Explicit classification of the cited synthetic source.",
      };
    };
    call.reply({
      occupation: judgment("software_engineering", targetTitle),
      seniority: judgment("senior", targetTitle),
      countries: [judgment("ES", targetLocation)],
      geography_scope: judgment("locality", targetLocation),
      locality: judgment("Madrid", targetLocation),
      market_scope: judgment("company", targetCompany),
      company_tier: judgment("unknown", targetCompany),
    });
  }
  await completed(api, run.runId);
}

test("Posted pay Known includes current employer amounts in their original currency and period", async ({ page, api, app }, testInfo) => {
  const settings = await json<{ revision: number }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", { expectedRevision: settings.revision, dailyBudgetUsd: 0 });
  const amounts = [
    { title: "Synthetic no-period role", salary: "Base salary EUR 85000 to EUR 95000.", currency: "EUR", period: "unknown", low: 85000, high: 95000, warnings: ["missing_period"] },
    { title: "Synthetic foreign-currency role", salary: "Base salary up to USD 120000 per year.", currency: "USD", period: "year", low: null, high: 120000, warnings: ["one_sided_range"] },
    { title: "Synthetic annual-EUR role", salary: "Base salary EUR 77000 to EUR 88000 per year.", currency: "EUR", period: "year", low: 77000, high: 88000, warnings: [] },
  ];
  const jobs: Job[] = [];
  for (const [index, amount] of amounts.entries()) {
    const job = await json<Job>(api, "post", "/v1/jobs/capture", {
      url: `https://example.com/jobs/posted-pay-${index}`, title: amount.title, company: "Synthetic Employer",
      location: targetLocation, description: "Manage the synthetic test operation.", salary: amount.salary,
    });
    jobs.push(job);
    const run = await action(api, "compensation.refresh", { jobId: job.job_id, includeEuroTopTech: false });
    const pay = await modelCall(app, "compensation.posted_pay");
    const source = (pay.body["sources"] as { source_id: string; text: string }[])[0]!;
    expect(source.text).toBe(amount.salary);
    pay.reply({
      parse_state: "parsed_range", currency: amount.currency, period: amount.period, component: "base_salary",
      minimum_amount: amount.low, maximum_amount: amount.high, confidence: "high", warnings: amount.warnings,
      citations: [{ source_id: source.source_id, quote: source.text }], rationale: "The cited employer text supplies the stated bounds.",
    });
    (await modelCall(app, "compensation.classification")).invalidJson();
    expect((await terminal(api, run.runId)).status).toBe("failed");
  }
  await json(api, "post", "/v1/jobs/capture", {
    url: "https://example.com/jobs/unassessed-pay", title: "Synthetic unassessed role", company: "Synthetic Employer",
    location: targetLocation, description: "Operate the synthetic test.", salary: "Base salary EUR 75000 per year.",
  });
  const calls = app.external.calls.length;
  await page.goto("/jobs");
  const table = page.getByRole("table", { name: "Jobs table", exact: true });
  const choose = async (label: string) => {
    const dialog = await columnFilter(page, "posted_compensation", "Posted pay");
    await dialog.getByRole("combobox", { name: "Posted pay", exact: true }).selectOption({ label });
    await applyColumnFilter(page, dialog);
  };
  await choose("Known");
  await expect(table.locator("tbody tr")).toHaveCount(3);
  for (const amount of amounts) await expect(table.getByRole("link", { name: amount.title, exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("known-employer-posted-pay.png") });
  await page.getByRole("button", { name: "Save as view", exact: true }).click();
  const save = page.getByRole("dialog", { name: "Save view", exact: true });
  await save.getByLabel("Name", { exact: true }).fill("Employer-stated amounts");
  await save.getByRole("button", { name: "Save", exact: true }).click();
  await expect(save).toHaveCount(0);
  await page.goto("/jobs");
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(page.getByRole("combobox", { name: "Saved table view", exact: true })).toContainText("Employer-stated amounts");
  const query = (filter: string) => json<Query>(api, "get", `/v1/jobs/query?${filter}`);
  const source = await query("posted_known=source_known");
  for (const id of [jobs[0]!.job_id, jobs[1]!.job_id]) {
    expect(source.rows.find((row) => row.job.job_id === id)?.scalars).toMatchObject({ compensation_min_eur: null, compensation_max_eur: null });
  }
  await choose("Known annual EUR");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.getByRole("link", { name: amounts[2]!.title })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("posted_known")).toBe("known");
  expect((await query("posted_known=source_known&posted_min_eur=1")).rows.map((row) => row.job.job_id)).toEqual([jobs[2]!.job_id]);
  expect((await query("posted_known=unknown")).total).toBe(3);
  await json(api, "patch", `/v1/jobs/${jobs[1]!.job_id}`, { expectedRevision: jobs[1]!.revision, description: "The employer revised this role." });
  await choose("Unknown");
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(table.getByRole("link", { name: amounts[1]!.title })).toBeVisible();
  await expect(table.getByRole("link", { name: "Synthetic unassessed role" })).toBeVisible();
  expect(app.external.calls.length).toBe(calls);
});

test.describe("Posted pay on a server with annual EUR filters", () => {
  test.use({ features: "jobs,compensation", sourceRevision: "17f9ce5be1de2f21735fb27d5dfe8f6d1b7c8118" });
  test("Jobs offers supported Posted pay choices and preserves a legacy revision across upgrade", async ({ api, app, page }) => {
    await capture(api, "legacy-pay-first", "Synthetic legacy pay first");
    await capture(api, "legacy-pay-second", "Synthetic legacy pay second");
    const annual = "/v1/jobs/query?posted_known=unknown&limit=1";
    const before = await json<Query>(api, "get", annual);
    expect(before.total).toBe(2);
    const nextPage = `${annual}&offset=1&query_revision=${before.query_revision}`;
    const next = await json<Query>(api, "get", nextPage);
    await page.goto("/jobs?grid=v1&posted_known=unknown");
    await expect(page.getByRole("table", { name: "Jobs table", exact: true }).locator("tbody tr")).toHaveCount(2);
    let dialog = await columnFilter(page, "posted_compensation", "Posted pay");
    const select = dialog.getByRole("combobox", { name: "Posted pay", exact: true });
    await expect(select).toHaveValue("unknown");
    await expect(select.locator("option")).toHaveText(["All", "Known annual EUR", "Unknown annual EUR"]);
    await page.keyboard.press("Escape");
    await app.upgradeSource();
    const after = await json<Query>(api, "get", nextPage);
    expect(after.query_revision).toBe(before.query_revision);
    expect(after.rows.map((row) => row.job.job_id)).toEqual(next.rows.map((row) => row.job.job_id));
    await page.reload();
    await expect(page.getByRole("table", { name: "Jobs table", exact: true }).locator("tbody tr")).toHaveCount(2);
    dialog = await columnFilter(page, "posted_compensation", "Posted pay");
    await expect(dialog.getByRole("combobox", { name: "Posted pay", exact: true })).toHaveValue("unknown");
    await expect(dialog.getByRole("option", { name: "Known", exact: true })).toHaveCount(1);
    expect(app.external.calls.length).toBe(0);
  });
});

test("Jobs sorts and facets the complete set, then restores a source-bound filtered saved view", async ({
  page,
  api,
  app,
  allowResponseError,
}, testInfo) => {
  const desktopViewport = page.viewportSize()!;
  const { library } = await createBaseline(api);
  // This journey records the existing score stage. Tailored preparation has
  // separate wording/coverage prerequisites and is covered in its own journey.
  const settings = await json<{ revision: number }>(api, "get", "/v1/settings");
  expect(
    await json(api, "patch", "/v1/settings", {
      expectedRevision: settings.revision,
      resumeMode: "baseline",
    }),
  ).toMatchObject({ resumeMode: "baseline" });
  // The scored target is deliberately captured before more than one page of
  // newer jobs. Sorting a hydrated first page alone cannot find it.
  const target = await capture(api, "grid-global-fit", targetTitle);
  const fillers: Job[] = [];
  for (let index = 0; index < 51; index += 1) {
    fillers.push(
      await capture(
        api,
        `grid-filler-${index}`,
        `Synthetic Grid Filler ${String(index).padStart(2, "0")}`,
      ),
    );
  }
  await qualifyPosting(api, app, target, library);
  const callsBeforePreparation = app.external.calls.length;
  const preparation = await action(api, "preparation.run", {
    recipe: "score",
    job_ids: [target.job_id],
    scope: "selected",
  });
  await completed(api, preparation.runId);
  expect(app.external.calls.length).toBe(callsBeforePreparation);
  await recordCompensation(api, app, target);

  const initial = await json<Query>(api, "get", "/v1/jobs/query");
  expect(initial.total).toBe(52);
  expect(initial.rows).toHaveLength(50);
  expect(initial.rows.map((row) => row.job.job_id)).not.toContain(
    target.job_id,
  );
  expect(initial.facets["fit_score"]).toMatchObject({
    values: expect.arrayContaining(["10"]),
    complete: true,
  });
  expect(initial.facets["current_stage"]?.values).toContain("fit");

  const legacyViewName = "Synthetic legacy Jobs view";
  const jobsViewsKey = "jh:python-jobs-table-views:v1";
  await page.addInitScript(
    ({ origin, value }) => {
      if (
        location.origin === origin &&
        localStorage.getItem("jh:saved-table-views") === null
      ) {
        localStorage.setItem("jh:saved-table-views", value);
      }
    },
    {
      origin: new URL(app.baseURL).origin,
      value: JSON.stringify({
        version: 4,
        state: {
          activeViewIdByTable: { jobs: "synthetic-legacy-jobs" },
          views: [
            {
              id: "synthetic-legacy-jobs",
              tableId: "jobs",
              name: legacyViewName,
              builtIn: false,
              columns: { order: ["select", "title"], hidden: [], widths: {} },
              density: null,
              grouping: null,
              colorRules: [],
              schemaVersion: 1,
              sort: { columnId: "title", direction: "asc" },
              urlFilters: {
                q: "synthetic legacy filter matches no current job",
              },
              gridFilters: {},
            },
          ],
        },
      }),
    },
  );
  await page.goto("/jobs");
  await expect(page).toHaveURL(/\/jobs/);
  await expect(page).toHaveTitle(/JobCtrl/);
  await expect(
    page.getByRole("heading", { name: "Jobs", exact: true }),
  ).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  const table = page.getByRole("table", { name: "Jobs table", exact: true });
  await expect(
    page.getByLabel("Filter saved jobs", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("combobox", { name: "Saved table view", exact: true }),
  ).not.toContainText(legacyViewName);
  await expect(table.locator("tbody tr")).toHaveCount(50);
  expect(
    await table
      .locator("thead th")
      .evaluateAll((columns) =>
        columns.map((column) => column.getAttribute("data-column-id")),
      ),
  ).toEqual([
    "select",
    "title",
    "company",
    "location",
    "posted_compensation",
    "fit_score",
    "apply_status",
  ]);
  await expect(
    table.getByRole("link", { name: targetTitle, exact: true }),
  ).toHaveCount(0);

  await page
    .getByRole("button", { name: "Configure table columns", exact: true })
    .click();
  const columnsDialog = page.getByRole("dialog", {
    name: "Columns",
    exact: true,
  });
  await columnsDialog
    .getByRole("checkbox", { name: "Stage", exact: true })
    .check();
  await page.keyboard.press("Escape");
  await table
    .getByRole("button", { name: "Filter Stage column", exact: true })
    .click();
  const stages = page.getByRole("dialog", {
    name: "Stage filter",
    exact: true,
  });
  await expect(
    stages.getByRole("checkbox", { name: "fit", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(stages).not.toBeVisible();

  await table
    .getByRole("button", { name: "Sort by Person fit", exact: true })
    .click();
  await table
    .getByRole("button", {
      name: "Sort by Person fit (ascending)",
      exact: true,
    })
    .click();
  await expect(table.locator('th[data-column-id="fit_score"]')).toHaveAttribute(
    "aria-sort",
    "descending",
  );
  await expect(
    table
      .locator("tbody tr")
      .first()
      .getByRole("link", { name: targetTitle, exact: true }),
  ).toBeVisible();
  await expect(table.locator("tbody tr").nth(1)).toContainText("Not assessed");

  await table
    .getByRole("button", { name: "Filter Stage column", exact: true })
    .click();
  await stages.getByRole("checkbox", { name: "fit", exact: true }).check();
  await expect(stages).toBeVisible();
  // The modal hides its background from accessibility. Inspect accepted rows
  // without interacting with that background while keeping this dialog open.
  const backgroundTable = page.getByRole("table", {
    name: "Jobs table",
    exact: true,
    includeHidden: true,
  });
  await expect(backgroundTable.locator("tbody tr")).toHaveCount(1);
  const unknownStage = stages.getByRole("checkbox", {
    name: "Unknown (no recorded value)",
    exact: true,
  });
  await unknownStage.check();
  await expect(
    stages.getByRole("checkbox", { name: "fit", exact: true }),
  ).toBeChecked();
  await expect(backgroundTable.locator("tbody tr")).toHaveCount(50);
  await unknownStage.uncheck();
  await expect(
    stages.getByRole("checkbox", { name: "fit", exact: true }),
  ).toBeChecked();
  await expect(backgroundTable.locator("tbody tr")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(page.getByText("Filter by fit, compensation and job state", { exact: true })).toHaveCount(0);
  // The column header and the compact picker open the same Jobs-owned editor.
  // Salary, market, reliability, warning and date columns remain hidden here.
  await table.getByRole("button", { name: "Filter Person fit column", exact: true }).click();
  let column = page.getByRole("dialog", { name: "Person fit filter", exact: true });
  await column
    .getByRole("combobox", { name: "Fit assessment", exact: true })
    .selectOption("current");
  await column
    .getByLabel("Minimum person fit (1–10)", { exact: true })
    .fill("10");
  await column.getByLabel("Maximum person fit (1–10)", { exact: true }).fill("9");
  await column.getByRole("button", { name: "Apply filters", exact: true }).click();
  await expect(column.getByRole("alert")).toHaveText("Minimum must not exceed maximum.");
  await column.getByLabel("Maximum person fit (1–10)", { exact: true }).fill("10");
  await applyColumnFilter(page, column);
  column = await columnFilter(page, "posted_compensation", "Posted pay");
  await column
    .getByRole("combobox", { name: "Posted pay", exact: true })
    .selectOption("known");
  await applyColumnFilter(page, column);
  column = await columnFilter(page, "compensation_market", "Market (€ / year)");
  await column
    .getByRole("combobox", { name: "Market pay", exact: true })
    .selectOption("known");
  await column
    .getByLabel("Market annual minimum at least (€)", { exact: true })
    .fill("85000");
  await column.getByLabel("Market annual maximum at most (€)", { exact: true }).fill("110000");
  await applyColumnFilter(page, column);
  await expect(table.locator('thead th[data-column-id="compensation_min_eur"]')).toHaveCount(0);
  column = await columnFilter(page, "compensation_min_eur", "Salary min (€ / year)");
  await column
    .getByLabel("Posted annual minimum at least (€)", { exact: true })
    .fill("80000");
  await applyColumnFilter(page, column);
  column = await columnFilter(page, "compensation_max_eur", "Salary max (€ / year)");
  await column.getByLabel("Posted annual maximum at most (€)", { exact: true }).fill("100000");
  await applyColumnFilter(page, column);
  // A future discovered cutoff excludes this job; the earlier assessed cutoff
  // brings it back because the two date criteria deliberately use OR.
  column = await columnFilter(page, "discovered_at", "Discovered");
  await column.getByLabel("Discovered since", { exact: true }).fill("2099-01-01");
  await applyColumnFilter(page, column);
  await expect(table.locator("tbody tr")).toHaveCount(0);
  column = await columnFilter(page, "scored_at", "Fit assessed");
  await expect(column.getByText("When both Discovered since and Fit assessed since are set, a job matching either date is included.", { exact: true })).toBeVisible();
  await column.getByLabel("Fit assessed since", { exact: true }).fill("2000-01-01");
  await applyColumnFilter(page, column);
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(
    table.getByRole("link", { name: targetTitle, exact: true }),
  ).toBeVisible();

  const scoredRows = await json<Query>(api, "get", "/v1/jobs/query?sort=fit_score&direction=desc");
  const targetValues = scoredRows.rows.find((row) => row.job.job_id === target.job_id)!.scalars;
  const reliabilityBand = String(targetValues["compensation_confidence"]);
  expect(["none", "low", "medium", "high"]).toContain(reliabilityBand);
  const reliabilityLabel = reliabilityBand === "none" ? "Not assessed" : reliabilityBand.charAt(0).toUpperCase() + reliabilityBand.slice(1);
  column = await columnFilter(page, "compensation_confidence", "Reliability");
  await column.getByRole("checkbox", { name: "Unknown (no recorded value)", exact: true }).check();
  await applyColumnFilter(page, column);
  await expect(table.locator("tbody tr")).toHaveCount(0);
  await page.getByLabel("Active table filters").getByRole("button").filter({ hasText: "Reliability" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  column = await columnFilter(page, "compensation_confidence", "Reliability");
  await column.getByRole("checkbox", { name: reliabilityLabel, exact: true }).check();
  await applyColumnFilter(page, column);
  expect(typeof targetValues["compensation_warnings"]).toBe("number");
  const warningState = Number(targetValues["compensation_warnings"]) > 0 ? "present" : "none";
  column = await columnFilter(page, "compensation_warnings", "Warnings");
  await column.getByRole("combobox", { name: "Compensation warnings", exact: true }).selectOption(warningState);
  await applyColumnFilter(page, column);
  await expect(table.locator("tbody tr")).toHaveCount(1);

  // Direct URLs and older saved column predicates retain their full meaning.
  // Applying an unchanged date editor must not truncate the recorded instant.
  const discoveredInstant = "2099-01-01T15:30:45.123Z";
  const assessedInstant = "2000-01-01T09:10:11.123Z";
  const deepLink = new URL(page.url());
  deepLink.searchParams.set("discovered_since", discoveredInstant);
  deepLink.searchParams.set("scored_since", assessedInstant);
  deepLink.searchParams.set("column_filters", JSON.stringify({
    ...JSON.parse(deepLink.searchParams.get("column_filters") ?? "{}"),
    job_state: { operator: "contains", text: "", selectedValues: ["active"] },
  }));
  await page.goto(`${deepLink.pathname}${deepLink.search}`);
  await expect(table.locator("tbody tr")).toHaveCount(1);
  column = await columnFilter(page, "discovered_at", "Discovered");
  await expect(column.getByLabel("Discovered since", { exact: true })).toHaveValue("2099-01-01");
  await applyColumnFilter(page, column);
  expect(new URL(page.url()).searchParams.get("discovered_since")).toBe(discoveredInstant);
  expect(new URL(page.url()).searchParams.get("scored_since")).toBe(assessedInstant);
  column = await columnFilter(page, "job_state", "Job state");
  await expect(column.getByRole("checkbox", { name: "Active", exact: true })).toBeChecked();
  await expect(column.getByRole("region", { name: "Saved column constraint", exact: true })).toContainText("active");
  await applyColumnFilter(page, column);
  expect(JSON.parse(new URL(page.url()).searchParams.get("column_filters") ?? "{}").job_state.selectedValues).toEqual(["active"]);

  column = await columnFilter(page, "compensation_max_eur", "Salary max (€ / year)");
  await column.getByRole("button", { name: "Clear column filter", exact: true }).click();
  await expect(column.getByLabel("Posted annual maximum at most (€)", { exact: true })).toHaveValue("");
  await applyColumnFilter(page, column);
  expect(new URL(page.url()).searchParams.has("posted_max_eur")).toBe(false);
  column = await columnFilter(page, "fit_score", "Person fit");
  await applyColumnFilter(page, column);
  expect(new URL(page.url()).searchParams.has("posted_max_eur")).toBe(false);
  expect(new URL(page.url()).searchParams.get("posted_min_eur")).toBe("80000");
  column = await columnFilter(page, "compensation_max_eur", "Salary max (€ / year)");
  await column.getByLabel("Posted annual maximum at most (€)", { exact: true }).fill("100000");
  await applyColumnFilter(page, column);

  column = await columnFilter(page, "compensation_market", "Market (€ / year)");
  await testInfo.attach("jobs-column-filter-desktop", { contentType: "image/png", body: await page.screenshot({ animations: "disabled" }) });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  column = await columnFilter(page, "compensation_market", "Market (€ / year)");
  await expect(column.getByLabel("Market annual maximum at most (€)", { exact: true })).toBeVisible();
  await testInfo.attach("jobs-column-filter-mobile", { contentType: "image/png", body: await page.screenshot({ animations: "disabled" }) });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("combobox", { name: "Filter a column", exact: true })).toBeFocused();
  await page.setViewportSize(desktopViewport);

  const customColumnIds = await table
    .locator("thead th")
    .evaluateAll((columns) =>
      columns.map((column) => column.getAttribute("data-column-id")),
    );
  await page.getByRole("button", { name: "Save as view", exact: true }).click();
  const save = page.getByRole("dialog", { name: "Save view", exact: true });
  await save.getByLabel("Name", { exact: true }).fill("Global fit and pay");
  await save.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await page.evaluate((key) => localStorage.getItem(key), jobsViewsKey)
        )?.includes("Global fit and pay") ?? false,
    )
    .toBe(true);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), jobsViewsKey),
  ).not.toContain(legacyViewName);
  // A filtered URL could restore the grid without consulting the saved view.
  // Start from the bare route so only the new Jobs store supplies these choices.
  await page.goto("/jobs");
  await expect(
    page.getByRole("combobox", { name: "Saved table view", exact: true }),
  ).toContainText("Global fit and pay");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  expect(
    await table
      .locator("thead th")
      .evaluateAll((columns) =>
        columns.map((column) => column.getAttribute("data-column-id")),
      ),
  ).toEqual(customColumnIds);
  await expect(
    table.getByRole("link", { name: targetTitle, exact: true }),
  ).toBeVisible();
  await expect(
    table.getByRole("button", {
      name: "Filter Stage column (active)",
      exact: true,
    }),
  ).toBeVisible();
  await expect(table.locator('th[data-column-id="fit_score"]')).toHaveAttribute(
    "aria-sort",
    "descending",
  );
  column = await columnFilter(page, "fit_score", "Person fit");
  await expect(
    column.getByLabel("Minimum person fit (1–10)", { exact: true }),
  ).toHaveValue("10");
  await expect(column.getByLabel("Maximum person fit (1–10)", { exact: true })).toHaveValue("10");
  await page.keyboard.press("Escape");
  column = await columnFilter(page, "posted_compensation", "Posted pay");
  await expect(
    column.getByRole("combobox", { name: "Posted pay", exact: true }),
  ).toHaveValue("known");
  await page.keyboard.press("Escape");
  column = await columnFilter(page, "compensation_market", "Market (€ / year)");
  await expect(
    column.getByLabel("Market annual minimum at least (€)", { exact: true }),
  ).toHaveValue("85000");
  await expect(column.getByLabel("Market annual maximum at most (€)", { exact: true })).toHaveValue("110000");
  await page.keyboard.press("Escape");
  column = await columnFilter(page, "discovered_at", "Discovered");
  await expect(column.getByLabel("Discovered since", { exact: true })).toHaveValue("2099-01-01");
  await page.keyboard.press("Escape");
  expect(new URL(page.url()).searchParams.get("discovered_since")).toBe(discoveredInstant);
  expect(new URL(page.url()).searchParams.get("scored_since")).toBe(assessedInstant);
  column = await columnFilter(page, "compensation_confidence", "Reliability");
  await expect(column.getByRole("checkbox", { name: reliabilityLabel, exact: true })).toBeChecked();
  await page.keyboard.press("Escape");
  column = await columnFilter(page, "compensation_warnings", "Warnings");
  await expect(column.getByRole("combobox", { name: "Compensation warnings", exact: true })).toHaveValue(warningState);
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Active table filters")).toContainText("either date");
  const filteredSearch = new URL(page.url()).search;
  const beforeSearchNavigation = app.external.calls.filter(
    (call) => call.path === "/model",
  ).length;
  await page
    .getByRole("link", { name: "Search preferences", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Search for jobs",
      level: 1,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Target roles 1", exact: true }),
  ).toBeEnabled();
  await page.getByRole("link", { name: "Back to jobs", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  expect(new URL(page.url()).search).toBe(filteredSearch);
  expect(
    await table
      .locator("thead th")
      .evaluateAll((columns) =>
        columns.map((column) => column.getAttribute("data-column-id")),
      ),
  ).toEqual(customColumnIds);
  expect(
    app.external.calls.filter((call) => call.path === "/model"),
  ).toHaveLength(beforeSearchNavigation);
  await table
    .getByRole("checkbox", { name: `Select ${target.title}`, exact: true })
    .check();
  await table.getByRole("link", { name: targetTitle, exact: true }).click();
  await expect(
    page.getByRole("main", { name: "Job details", exact: true }),
  ).toBeVisible();
  const detailSearch = new URL(page.url()).searchParams;
  detailSearch.delete("jobTab");
  expect(Object.fromEntries(detailSearch)).toEqual(
    Object.fromEntries(new URLSearchParams(filteredSearch)),
  );
  await expect(table).toBeVisible();
  await expect(
    table.getByRole("checkbox", {
      name: `Select ${target.title}`,
      exact: true,
    }),
  ).toBeChecked();
  // The comparison pane has real horizontal scrolling on desktop. Mobile
  // deliberately renders stacked cells, so it has no horizontal overflow.
  const horizontalScroll = page.locator(".filterable-data-grid-scroll");
  await horizontalScroll.evaluate((element) => {
    element.scrollLeft = 24;
  });
  const retainedScroll = await horizontalScroll.evaluate(
    (element) => element.scrollLeft,
  );
  expect(retainedScroll).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Back to jobs", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  expect(new URL(page.url()).search).toBe(filteredSearch);
  await expect(
    table.getByRole("checkbox", {
      name: `Select ${target.title}`,
      exact: true,
    }),
  ).toBeChecked();
  expect(await horizontalScroll.evaluate((element) => element.scrollLeft)).toBe(
    retainedScroll,
  );
  await table.scrollIntoViewIfNeeded();
  await testInfo.attach("jobs-global-filter-saved-view", {
    contentType: "image/png",
    body: await page.screenshot(),
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await table.getByRole("link", { name: targetTitle, exact: true }).click();
  await expect(
    page.getByRole("main", { name: "Job details", exact: true }),
  ).toBeVisible();
  await expect(table).toBeHidden();
  await page.getByRole("button", { name: "Back to jobs", exact: true }).click();
  await expect(table).toBeVisible();
  await expect(
    table.getByRole("checkbox", {
      name: `Select ${target.title}`,
      exact: true,
    }),
  ).toBeChecked();
  expect(new URL(page.url()).search).toBe(filteredSearch);
  await page.setViewportSize(desktopViewport);

  // Exercise the real continuation UI: changed sources must not mix page two
  // with the first page's earlier owner snapshot.
  await page
    .getByRole("button", { name: "Clear all filters", exact: true })
    .click();
  await expect(table.locator("tbody tr")).toHaveCount(50);
  const secondPage = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "GET" &&
      url.pathname === "/v1/jobs/query" &&
      url.searchParams.get("offset") === "50" &&
      response.status() === 200
    );
  });
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    page.getByText("Page 2 of 2 · 52 rows", { exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("offset")).toBe("50");
  expect(new URL(page.url()).searchParams.get("query_revision")).toBeTruthy();
  const secondPageUrl = (await secondPage).url();
  const conflicts: Response[] = [];
  const observeConflict = (response: Response) => {
    if (
      response.request().method() === "GET" &&
      response.url() === secondPageUrl
    )
      conflicts.push(response);
  };
  page.on("response", observeConflict);
  try {
    await json(api, "post", `/v1/jobs/${fillers[0]!.job_id}/hide`, {});
    await expect(
      page.getByRole("alert").filter({ hasText: "sources changed" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Reload from first page", exact: true })
      .click();
    await expect(
      page.getByText("Page 1 of 2 · 51 rows", { exact: true }),
    ).toBeVisible();
    expect(new URL(page.url()).searchParams.get("offset")).toBe("0");
    expect(new URL(page.url()).searchParams.has("query_revision")).toBe(false);
  } finally {
    page.off("response", observeConflict);
  }
  expect(conflicts.length).toBeGreaterThan(0);
  for (const response of conflicts) {
    await allowResponseError(response, {
      method: "GET",
      status: 409,
      code: "revision_conflict",
    });
  }
  expect((await json<Query>(api, "get", "/v1/jobs/query")).total).toBe(51);
});

test("Jobs keeps selected actions compact while secondary workflows preserve the selection", async ({ api, app, page }, testInfo) => {
  const first = await capture(api, "selection-first", "Synthetic Selection Engineer");
  const second = await capture(api, "selection-second", "Synthetic Selection Lead");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/jobs");
  const table = page.getByRole("table", { name: "Jobs table", exact: true });
  for (const job of [first, second]) await table.getByRole("checkbox", { name: `Select ${job.title}`, exact: true }).check();
  const actions = page.getByRole("group", { name: "Selected jobs actions", exact: true });
  await expect(actions.getByText("2 selected", { exact: true })).toBeVisible();
  for (const label of ["Hide", "Unhide", "Delete", "Restore", "Clear selection"]) {
    await expect(actions.getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  await expect(actions.getByRole("button", { name: "Delete", exact: true })).toHaveAttribute("title", "Move to Deleted. You can restore these jobs later.");

  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const geometry = await actions.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const buttons = Array.from(element.querySelectorAll("button")).map((button) => {
        const rect = button.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height };
      });
      return { left: box.left, right: box.right, viewport: document.documentElement.clientWidth, buttons };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
    for (const [index, button] of geometry.buttons.entries()) {
      expect(button.left).toBeGreaterThanOrEqual(geometry.left);
      expect(button.right).toBeLessThanOrEqual(geometry.right);
      if (width === 390) expect(button.height).toBeGreaterThanOrEqual(44);
      for (const other of geometry.buttons.slice(index + 1)) {
        expect(button.left >= other.right || other.left >= button.right || button.top >= other.bottom || other.top >= button.bottom).toBe(true);
      }
    }
  }

  const toolbar = page.locator(".jobs-selection");
  const before = await toolbar.boundingBox();
  const matchesTrigger = actions.getByRole("button", { name: "Update affected matches", exact: true });
  await matchesTrigger.click();
  const matches = page.getByRole("dialog", { name: "Update affected matches", exact: true });
  await expect(matches).toBeVisible();
  await expect(matches).toContainText("2 selected jobs");
  await expect(matches.getByRole("region", { name: "Affected matches", exact: true })).toBeVisible();
  expect((await toolbar.boundingBox())?.height).toBe(before?.height);
  await page.keyboard.press("Escape");
  await expect(matches).not.toBeVisible();
  await expect(matchesTrigger).toBeFocused();

  const preparationTrigger = actions.getByRole("button", { name: "Preparation tools", exact: true });
  await preparationTrigger.click();
  const preparation = page.getByRole("dialog", { name: "Selected jobs preparation", exact: true });
  await expect(preparation).toBeVisible();
  const override = preparation.getByRole("checkbox", { name: "Prepare selected jobs below the saved fit threshold", exact: true });
  await override.check();
  await preparation.getByRole("tab", { name: "History", exact: true }).click();
  await expect(preparation.getByText("No preparation runs recorded.", { exact: true })).toBeVisible();
  await expect(override).not.toBeVisible();
  await preparation.getByRole("tab", { name: "Tools", exact: true }).click();
  await expect(override).toBeChecked();
  expect((await toolbar.boundingBox())?.height).toBe(before?.height);
  await testInfo.attach("jobs-selected-preparation-mobile", { contentType: "image/png", body: await page.screenshot({ animations: "disabled" }) });
  await preparation.getByRole("button", { name: "Close", exact: true }).click();
  await expect(preparationTrigger).toBeFocused();
  await preparationTrigger.click();
  await expect(override).toBeChecked();
  await page.keyboard.press("Escape");
  for (const job of [first, second]) await expect(table.getByRole("checkbox", { name: `Select ${job.title}`, exact: true })).toBeChecked();
  await actions.getByRole("button", { name: "Clear selection", exact: true }).click();
  await expect(actions).toHaveCount(0);
  for (const job of [first, second]) await expect(table.getByRole("checkbox", { name: `Select ${job.title}`, exact: true })).not.toBeChecked();
  expect(app.external.calls).toHaveLength(0);
});

test("permanent job deletion reports and retries pending file cleanup", async ({ page, api, app }) => {
  const { profile } = await createBaseline(api);
  const posting = await capture(api, "cleanup-target", "Synthetic Cleanup Target");
  const resume = await acceptBaseline(api, posting.job_id, profile.profileVersion);
  const artifact = current(resume).renders[0]!;
  expect(artifact.artifact_id).toMatch(/^[a-f0-9-]{36}$/);
  const pdf = path.join(app.workspace, "resumes-artifacts", `${artifact.artifact_id}.pdf`);
  const extraLink = path.join(app.workspace, "synthetic-pdf-hard-link");
  const { databaseInstanceId } = await json<{ databaseInstanceId: string }>(api, "get", "/v1/health");
  await json(api, "post", `/v1/jobs/${posting.job_id}/delete`, {});
  await page.goto("/jobs?grid=v1&job_state=deleted");
  const table = page.getByRole("table", { name: "Jobs table", exact: true });
  await table.getByRole("checkbox", { name: `Select ${posting.title}`, exact: true }).check();
  await page.getByRole("button", { name: "Review permanent deletion", exact: true }).click();
  const review = page.getByRole("region", { name: "Review permanent deletion", exact: true });
  const confirm = review.getByRole("button", { name: "Permanently delete reviewed jobs", exact: true });
  await expect(confirm).toBeDisabled();
  await review.getByLabel("Type DELETE to confirm", { exact: true }).fill("DELETE");
  const nextDeletion = () => page.waitForResponse((response) => new URL(response.url()).pathname === "/v1/jobs/bulk-delete-permanent");
  const pending = page.getByRole("region", { name: "Pending file cleanup", exact: true });
  const response = nextDeletion();
  // The production retire operation must refuse a file with a second hard link.
  await link(pdf, extraLink);
  try {
    await confirm.click();
    const committed = await response;
    expect(committed.status()).toBe(200);
    expect(committed.request().headers()["expected-database-instance-id"]).toBe(databaseInstanceId);
    expect(await committed.json()).toMatchObject({ affected: 1, deletionCommitted: true, cleanupPending: true, replayed: false });
    expect((await lstat(pdf)).nlink).toBe(2);
    expect((await api.get(`/v1/jobs/${posting.job_id}`)).status()).toBe(404);
    await expect(review).toHaveCount(0);
    await expect(pending.getByText("The job records were deleted.", { exact: false })).toBeVisible();
  } finally {
    await unlink(extraLink);
  }

  await page.getByRole("link", { name: "My profile", exact: true }).click();
  await expect(page).toHaveURL(/\/profile/);
  await page.getByRole("link", { name: "Jobs", exact: true }).click();
  const replay = nextDeletion();
  await pending.getByRole("button", { name: "Retry file cleanup", exact: true }).click();
  const cleaned = await replay;
  expect(cleaned.status()).toBe(200);
  expect(cleaned.request().postDataJSON()).toEqual((await response).request().postDataJSON());
  expect(cleaned.request().headers()["expected-database-instance-id"]).toBe(databaseInstanceId);
  expect(await cleaned.json()).toMatchObject({ affected: 1, deletionCommitted: true, cleanupPending: false, replayed: true });
  await expect(pending).toHaveCount(0);
  await expect(page.getByText("File cleanup completed.", { exact: true })).toBeVisible();
  await expect(lstat(pdf)).rejects.toMatchObject({ code: "ENOENT" });
});

test.describe("Jobs without optional read owners", () => {
  test.use({ features: "profile,jobs" });

  test("unavailable criteria stay explicit and bulk deletion fences the exact reviewed selection", async ({
    page,
    api,
    app,
    allowResponseError,
  }, testInfo) => {
    const target = await capture(
      api,
      "guarded-target",
      "Synthetic Guarded Target",
    );
    const peer = await capture(api, "guarded-peer", "Synthetic Preserved Peer");
    const available = await json<Query>(api, "get", "/v1/jobs/query");
    expect(available.modules["compensation"]).toEqual({
      enabled: false,
      available: false,
    });
    await page.goto("/jobs");
    await expect(
      page.getByRole("heading", { name: "Jobs", exact: true }),
    ).toBeVisible();
    const table = page.getByRole("table", { name: "Jobs table", exact: true });
    await expect(table.locator("tbody tr")).toHaveCount(2);
    await expect(
      page.getByRole("status").filter({ hasText: "compensation (disabled)" }),
    ).toBeVisible();
    await expect(
      table.getByRole("button", { name: "Sort by Person fit", exact: true }),
    ).toHaveCount(0);

    const postedFilter = await columnFilter(page, "posted_compensation", "Posted pay");
    await expect(postedFilter.getByRole("status")).toContainText("Feature disabled");
    await postedFilter
      .getByRole("combobox", { name: "Posted pay", exact: true })
      .selectOption("known");
    const unavailableQuery = {
      job_state: "active",
      sort: "discovered_at",
      direction: "desc",
      offset: "0",
      limit: "50",
      fit_state: "all",
      posted_known: "known",
      market_known: "all",
      compensation_warnings: "all",
    };
    const unavailableResponses: Response[] = [];
    const observeUnavailable = (response: Response) => {
      const url = new URL(response.url());
      if (
        response.request().method() === "GET" &&
        url.pathname === "/v1/jobs/query" &&
        Array.from(url.searchParams).length ===
          Object.keys(unavailableQuery).length &&
        Object.entries(unavailableQuery).every(
          ([key, value]) => url.searchParams.get(key) === value,
        )
      )
        unavailableResponses.push(response);
    };
    page.on("response", observeUnavailable);
    try {
      await postedFilter
        .getByRole("button", { name: "Apply filters", exact: true })
        .click();
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("alert").filter({ hasText: "unavailable feature" }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Clear all filters", exact: true })
        .click();
      await expect(table.locator("tbody tr")).toHaveCount(2);
    } finally {
      page.off("response", observeUnavailable);
    }
    expect(unavailableResponses.length).toBeGreaterThan(0);
    for (const response of unavailableResponses) {
      await allowResponseError(response, {
        method: "GET",
        status: 409,
        code: "query_feature_unavailable",
      });
      expect((await response.json()).error.details.fields).toEqual([
        "compensation_min_eur",
      ]);
    }

    await table
      .getByRole("checkbox", { name: `Select ${target.title}`, exact: true })
      .check();
    await table
      .getByRole("checkbox", { name: `Select ${peer.title}`, exact: true })
      .check();
    await expect(
      page.getByRole("button", {
        name: "Review permanent deletion",
        exact: true,
      }),
    ).toHaveCount(0);
    await json(api, "post", `/v1/jobs/${peer.job_id}/hide`, {});
    const stale = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/v1/jobs/bulk-delete",
    );
    await page
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    const staleSelection = await stale;
    expect(staleSelection.request().postDataJSON()).toEqual({
      jobIds: [target.job_id, peer.job_id],
      expectedRevisions: {
        [target.job_id]: target.revision,
        [peer.job_id]: peer.revision,
      },
      expectedStateRevisions: {
        [target.job_id]: target.state_revision,
        [peer.job_id]: peer.state_revision,
      },
    });
    await allowResponseError(staleSelection, {
      method: "POST",
      status: 409,
      code: "revision_conflict",
    });
    expect((await staleSelection.json()).error.details.job_id).toBe(
      peer.job_id,
    );
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "selection remains available" }),
    ).toBeVisible();
    expect(
      (await json<Job>(api, "get", `/v1/jobs/${target.job_id}`)).deleted,
    ).toBe(false);
    expect(
      await json<Job>(api, "get", `/v1/jobs/${peer.job_id}`),
    ).toMatchObject({ hidden: true, deleted: false });

    await page
      .getByRole("button", { name: "Clear selection", exact: true })
      .click();
    await table
      .getByRole("checkbox", { name: `Select ${target.title}`, exact: true })
      .check();
    await page
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(
      table.getByRole("link", { name: target.title, exact: true }),
    ).toHaveCount(0);
    const jobState = await columnFilter(page, "job_state", "Job state");
    await jobState.getByRole("checkbox", { name: "Active", exact: true }).uncheck();
    await jobState.getByRole("checkbox", { name: "Deleted", exact: true }).check();
    await applyColumnFilter(page, jobState);
    await table
      .getByRole("checkbox", { name: `Select ${target.title}`, exact: true })
      .check();
    const previewResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
        "/v1/jobs/permanent-delete-selection",
    );
    await page
      .getByRole("button", { name: "Review permanent deletion", exact: true })
      .click();
    const preview = (await (await previewResponse).json()) as {
      selectionId: string;
      jobIds: string[];
    };
    expect(preview.jobIds).toEqual([target.job_id]);
    const review = page.getByRole("region", {
      name: "Review permanent deletion",
      exact: true,
    });
    await expect(review).toContainText(target.title);
    await expect(review).not.toContainText(peer.title);
    await expect(review).toContainText(/Independently saved learning plans/i);
    const confirm = review.getByRole("button", {
      name: "Permanently delete reviewed jobs",
      exact: true,
    });
    await expect(confirm).toBeDisabled();
    await review
      .getByLabel("Type DELETE to confirm", { exact: true })
      .fill("delete");
    await expect(confirm).toBeDisabled();
    const wrongSelection = await api.post("/v1/jobs/bulk-delete-permanent", {
      data: { selectionId: preview.selectionId, jobIds: [peer.job_id] },
    });
    expect(wrongSelection.status(), await wrongSelection.text()).toBe(409);
    await review.scrollIntoViewIfNeeded();
    await testInfo.attach("jobs-reviewed-delete-guard", {
      contentType: "image/png",
      body: await page.screenshot(),
    });
    await review
      .getByLabel("Type DELETE to confirm", { exact: true })
      .fill("DELETE");
    await confirm.click();
    await expect(review).not.toBeVisible();
    expect((await api.get(`/v1/jobs/${target.job_id}`)).status()).toBe(404);
    expect(
      await json<Job>(api, "get", `/v1/jobs/${peer.job_id}`),
    ).toMatchObject({ hidden: true, deleted: false });
    expect(app.external.calls).toHaveLength(0);
  });
});
