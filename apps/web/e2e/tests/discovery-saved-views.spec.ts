import { expect, test, type Page } from "@playwright/test";

async function saveAs(page: Page, name: string) {
  await page.getByRole("button", { name: "Save as view", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Save view", exact: true });
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page
      .getByRole("combobox", { name: "Saved table view" })
      .locator('[data-slot="select-value"]'),
  ).toHaveText(name);
}

async function selectView(page: Page, name: string) {
  await page.getByRole("combobox", { name: "Saved table view" }).click();
  await page.getByRole("option", { name, exact: true }).click();
}

async function filterCompany(page: Page, value: string) {
  await page.getByRole("button", { name: /^Filter Company column/ }).click();
  const dialog = page.getByRole("dialog", {
    name: "Company filter",
    exact: true,
  });
  await dialog.getByLabel("Company filter text").fill(value);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();
}

test("source review saves, switches, reloads and resets independently of Jobs", async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  // The Playwright server owns this synthetic SQLite workspace. No source fetch
  // or worker dispatch is needed to exercise the production review table.
  for (const [suffix, state] of [
    ["Alpha", "active"],
    ["Zulu", "active"],
    ["Inactive", "disabled"],
  ] as const) {
    const response = await page.request.post("/v1/discovery/sources", {
      headers: { Origin: baseURL! },
      data: {
        sourceId: `qa-saved-view-${suffix.toLowerCase()}`,
        displayName: `QA Saved ${suffix}`,
        kind: "employer_careers_page",
        priority: "standard",
        state,
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }

  await page.goto("/jobs");
  await expect(
    page.getByRole("heading", { name: "Jobs", exact: true }),
  ).toBeVisible();
  await saveAs(page, "Jobs sentinel");
  const jobsBefore = await page.evaluate(() => {
    const state = JSON.parse(
      localStorage.getItem("jh:saved-table-views")!,
    ).state;
    return {
      views: state.views.filter(
        (view: { tableId: string }) => view.tableId === "jobs",
      ),
      active: state.activeViewIdByTable.jobs,
      presentation: state.presentationByTable.jobs,
    };
  });

  await page.goto("/discovery");
  await expect(
    page.getByRole("heading", { name: "Discovery", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveTitle(/JobCtrl/);
  const table = page.getByRole("table", { name: "Grid view", exact: true });
  const grid = page
    .locator(".discovery-control-panel .filterable-data-grid")
    .first();
  await expect(table).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await expect(table).toContainText("QA Saved Alpha");
  await expect(table).not.toContainText("QA Saved Inactive");
  await filterCompany(page, "QA Saved");
  await page
    .getByRole("button", { name: "Sort by Company (ascending)", exact: true })
    .click();
  await expect(table.locator("tbody tr").first()).toContainText(
    "QA Saved Zulu",
  );

  await page.getByRole("button", { name: "Configure table columns" }).click();
  const columns = page.getByRole("dialog", { name: "Columns", exact: true });
  await columns
    .getByRole("checkbox", { name: "Source id", exact: true })
    .uncheck();
  await columns
    .getByRole("button", { name: "Move Type earlier", exact: true })
    .click();
  await columns
    .getByRole("button", { name: "Move Type earlier", exact: true })
    .click();
  await columns.getByRole("button", { name: "Compact", exact: true }).click();
  await columns.getByRole("button", { name: "Close", exact: true }).click();
  await expect(table.locator("thead th").first()).toHaveAttribute(
    "data-column-id",
    "type",
  );
  await expect(
    table.locator('thead th[data-column-id="sourceId"]'),
  ).toHaveCount(0);
  await expect(grid).toHaveAttribute("data-density", "compact");
  await page
    .getByRole("button", { name: "Resize Company column", exact: true })
    .press("ArrowRight");
  const companyColumn = table.locator(
    'colgroup col[data-column-id="displayName"]',
  );
  const savedWidth = await companyColumn.evaluate(
    (node) => (node as HTMLElement).style.width,
  );
  expect(savedWidth).not.toBe("");
  await saveAs(page, "Compact source review");
  const savedUrl = page.url();
  await filterCompany(page, "QA Saved Alpha");
  await saveAs(page, "Alpha only");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await selectView(page, "Compact source review");
  await expect(page).toHaveURL(savedUrl);
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(table.locator("tbody tr").first()).toContainText(
    "QA Saved Zulu",
  );
  await page.reload();
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(
    page
      .getByRole("combobox", { name: "Saved table view" })
      .locator('[data-slot="select-value"]'),
  ).toHaveText("Compact source review");
  await expect(grid).toHaveAttribute("data-density", "compact");
  await expect(table.locator("thead th").first()).toHaveAttribute(
    "data-column-id",
    "type",
  );
  await expect
    .poll(() =>
      companyColumn.evaluate((node) => (node as HTMLElement).style.width),
    )
    .toBe(savedWidth);
  await expect(
    table.locator('thead th[data-column-id="sourceId"]'),
  ).toHaveCount(0);
  await grid.screenshot({
    path: testInfo.outputPath("source-view-reloaded.png"),
  });

  // Unsaved URL edits must survive reload instead of replaying the named view.
  await filterCompany(page, "QA Saved Alpha");
  const editedUrl = page.url();
  await page.reload();
  await expect(page).toHaveURL(editedUrl);
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table).toContainText("QA Saved Alpha");
  await selectView(page, "Default");
  await expect(table).toContainText("QA Saved Zulu");
  await expect(table).not.toContainText("QA Saved Inactive");
  await expect(table.locator("thead th").first()).toHaveAttribute(
    "data-column-id",
    "displayName",
  );
  await expect(
    table.locator('thead th[data-column-id="sourceId"]'),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Sort by Company (ascending)",
      exact: true,
    }),
  ).toBeVisible();
  await expect(grid).not.toHaveAttribute("data-density", "compact");
  await expect
    .poll(() =>
      companyColumn.evaluate((node) => (node as HTMLElement).style.width),
    )
    .not.toBe(savedWidth);
  await page.reload();
  await expect(
    page
      .getByRole("combobox", { name: "Saved table view" })
      .locator('[data-slot="select-value"]'),
  ).toHaveText("Default");
  await expect(table).toContainText("QA Saved Zulu");

  const jobsAfter = await page.evaluate(() => {
    const state = JSON.parse(
      localStorage.getItem("jh:saved-table-views")!,
    ).state;
    return {
      views: state.views.filter(
        (view: { tableId: string }) => view.tableId === "jobs",
      ),
      active: state.activeViewIdByTable.jobs,
      presentation: state.presentationByTable.jobs,
    };
  });
  expect(jobsAfter).toEqual(jobsBefore);
  await page.goto("/jobs");
  await expect(
    page
      .getByRole("combobox", { name: "Saved table view" })
      .locator('[data-slot="select-value"]'),
  ).toHaveText("Jobs sentinel");
  await page.getByRole("combobox", { name: "Saved table view" }).click();
  await expect(
    page.getByRole("option", { name: "Compact source review" }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("presentation edits preserve the source review page", async ({
  page,
  baseURL,
}) => {
  for (let index = 0; index < 26; index += 1) {
    const suffix = String(index).padStart(2, "0");
    const response = await page.request.post("/v1/discovery/sources", {
      headers: { Origin: baseURL! },
      data: {
        sourceId: `qa-paging-${suffix}`,
        displayName: `QA Paging ${suffix}`,
        kind: "employer_careers_page",
        priority: "standard",
        state: "active",
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  await page.goto("/discovery");
  await filterCompany(page, "QA Paging");
  const table = page.getByRole("table", { name: "Grid view", exact: true });
  const grid = page
    .locator(".discovery-control-panel .filterable-data-grid")
    .first();
  await grid.getByRole("button", { name: "Next", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table).toContainText("QA Paging 25");
  await page
    .getByRole("button", { name: "Resize Company column", exact: true })
    .press("ArrowRight");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table).toContainText("QA Paging 25");
  await page.getByRole("button", { name: "Configure table columns" }).click();
  const dialog = page.getByRole("dialog", { name: "Columns", exact: true });
  await dialog.getByRole("button", { name: "Compact", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Move Type earlier", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(grid).toHaveAttribute("data-density", "compact");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table).toContainText("QA Paging 25");
});
