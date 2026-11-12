import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { APIRequestContext, Response } from "@playwright/test";

import {
  test,
  expect,
  json,
  action,
  completed,
  modelCall,
  type ApplicationStack,
} from "../harness/fixtures.js";
import { createBaseline, qualifyPosting, type Posting } from "./core-data.js";

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

test("Jobs sorts and facets the complete set, then restores a source-bound filtered saved view", async ({
  page,
  api,
  app,
  allowResponseError,
}, testInfo) => {
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
  await page
    .getByText("Filter by fit, compensation and job state", { exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Fit assessment", exact: true })
    .selectOption("current");
  await page
    .getByLabel("Minimum person fit (1–10)", { exact: true })
    .fill("10");
  await page
    .getByRole("combobox", { name: "Posted pay", exact: true })
    .selectOption("known");
  await page
    .getByRole("combobox", { name: "Market pay", exact: true })
    .selectOption("known");
  await page
    .getByLabel("Posted annual minimum at least (€)", { exact: true })
    .fill("80000");
  await page
    .getByLabel("Market annual minimum at least (€)", { exact: true })
    .fill("85000");
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(
    table.getByRole("link", { name: targetTitle, exact: true }),
  ).toBeVisible();

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
  await page
    .getByText("Filter by fit, compensation and job state", { exact: true })
    .click();
  await expect(
    page.getByLabel("Minimum person fit (1–10)", { exact: true }),
  ).toHaveValue("10");
  await expect(
    page.getByRole("combobox", { name: "Posted pay", exact: true }),
  ).toHaveValue("known");
  await expect(
    page.getByLabel("Market annual minimum at least (€)", { exact: true }),
  ).toHaveValue("85000");
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
  await page.setViewportSize({ width: 1440, height: 1000 });

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

    const filterOptions = page.locator("details.jobs-filter-options");
    const openFilters = async () => {
      if (
        !(await filterOptions.evaluate(
          (element) => (element as HTMLDetailsElement).open,
        ))
      )
        await filterOptions
          .locator("summary")
          .filter({ hasText: /^Filter by fit, compensation and job state$/ })
          .click();
      await expect(
        page.getByRole("form", { name: "Job filters", exact: true }),
      ).toBeVisible();
    };
    await openFilters();
    await page
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
      await page
        .getByRole("button", { name: "Apply filters", exact: true })
        .click();
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
    ).toBeDisabled();
    await json(api, "post", `/v1/jobs/${peer.job_id}/hide`, {});
    const stale = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/v1/jobs/bulk-delete",
    );
    await page
      .getByRole("button", { name: "Move selected to deleted", exact: true })
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
      .getByRole("button", { name: "Move selected to deleted", exact: true })
      .click();
    await expect(
      table.getByRole("link", { name: target.title, exact: true }),
    ).toHaveCount(0);
    await openFilters();
    await page
      .getByRole("combobox", { name: "Job state", exact: true })
      .selectOption("deleted");
    await page
      .getByRole("button", { name: "Apply filters", exact: true })
      .click();
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
    await expect(review).toContainText("Independently saved learning plans");
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
