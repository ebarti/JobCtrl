import { expect, type Locator, type Page, test } from "@playwright/test";

interface ResponsiveDataSurface {
  readonly name: string;
  readonly path: string;
  readonly table: (page: Page) => Locator;
  readonly surface: (page: Page) => Locator;
  readonly hasColumnControls: boolean;
  readonly layout: "custom" | "record-table";
  readonly mobileAffordance?: "details" | "row-activation";
}

const SURFACES: readonly ResponsiveDataSurface[] = [
  {
    name: "jobs",
    path: "/jobs",
    table: (page) => page.locator("table.jobs-data-grid-table"),
    surface: (page) => page.locator(".jobs-data-grid-table").locator(".."),
    hasColumnControls: true,
    layout: "custom",
    mobileAffordance: "row-activation",
  },
  {
    name: "artifacts",
    path: "/artifacts",
    table: (page) => page.locator("table.artifacts-data-grid-table"),
    surface: (page) => page.locator(".artifacts-data-grid-table").locator(".."),
    hasColumnControls: true,
    layout: "custom",
    mobileAffordance: "row-activation",
  },
  {
    name: "contacts",
    path: "/outreach",
    table: (page) => page.locator("table.contacts-data-grid-table"),
    surface: (page) => page.locator(".contacts-data-grid-table").locator(".."),
    hasColumnControls: true,
    layout: "custom",
    mobileAffordance: "row-activation",
  },
  {
    name: "runs",
    path: "/runs",
    table: (page) => page.locator("table.runs-data-grid-table"),
    surface: (page) => page.locator(".runs-data-grid-table").locator(".."),
    hasColumnControls: true,
    layout: "custom",
    mobileAffordance: "row-activation",
  },
  {
    name: "debug",
    path: "/debug",
    table: (page) => page.locator("table.activity-data-grid-table"),
    surface: (page) => page.locator(".activity-data-grid-table").locator(".."),
    hasColumnControls: true,
    layout: "custom",
    mobileAffordance: "details",
  },
  {
    name: "discovery-sources",
    path: "/discovery",
    table: (page) => page.getByRole("table", { name: "Grid view" }),
    surface: (page) =>
      page
        .getByRole("table", { name: "Grid view" })
        .locator("xpath=ancestor::div[contains(@class,'filterable-data-grid')]")
        .first(),
    hasColumnControls: true,
    layout: "record-table",
  },
  {
    name: "settings-compensation-sources",
    path: "/settings",
    table: (page) =>
      page.getByRole("table", { name: "Compensation source policy" }),
    surface: (page) => page.locator(".compensation-source-policy-panel"),
    hasColumnControls: false,
    layout: "record-table",
  },
];

function gridForTable(table: Locator): Locator {
  return table
    .locator("xpath=ancestor::div[contains(@class,'filterable-data-grid')]")
    .first();
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
}

async function expectMobileColumnControls(
  grid: Locator,
  enabled: boolean,
): Promise<void> {
  if (!enabled) return;
  const controls = grid.locator("details.data-grid-mobile-controls");
  await expect(controls).toBeVisible();
  await controls.locator("summary").click();
  await expect(controls).toHaveAttribute("open", "");
  await expect(
    controls.locator(".data-grid-sort-button").first(),
  ).toBeVisible();
  await controls.locator("summary").click();
  await expect(controls).not.toHaveAttribute("open", "");
}

async function expectCustomMobileRecords(
  page: Page,
  surface: ResponsiveDataSurface,
  table: Locator,
): Promise<Locator> {
  const grid = gridForTable(table);
  await expect(grid).toBeVisible();
  await expect(grid).toHaveAttribute("data-mobile-rows", "custom");
  await expect(table).toBeHidden();

  const list = grid.locator("ul.data-grid-mobile-records");
  const firstRecord = list.locator("li.data-grid-mobile-record").first();
  await expect(list).toBeVisible();
  await expect(firstRecord).toBeVisible({ timeout: 30_000 });

  const recordLayout = await firstRecord.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: document.documentElement.clientWidth,
      width: rect.width,
    };
  });
  expect(recordLayout.width).toBeGreaterThan(0);
  expect(recordLayout.left).toBeGreaterThanOrEqual(-1);
  expect(recordLayout.right).toBeLessThanOrEqual(
    recordLayout.viewportWidth + 1,
  );

  if (surface.mobileAffordance === "row-activation") {
    const action = firstRecord.locator(".data-grid-row-activation-button");
    await expect(action).toBeVisible();
    await expect(action).not.toHaveClass(/row-activation-focus-only/);
    const actionSize = await action.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { height: rect.height, width: rect.width };
    });
    expect(actionSize.height).toBeGreaterThanOrEqual(24);
    expect(actionSize.width).toBeGreaterThanOrEqual(24);
  } else {
    const disclosure = firstRecord.locator("details.activity-mobile-row");
    const summary = disclosure.locator("summary");
    await expect(disclosure).toBeVisible();
    await expect(summary).toBeVisible();
    const summaryHeight = await summary.evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    expect(summaryHeight).toBeGreaterThanOrEqual(24);
    await summary.click();
    await expect(disclosure).toHaveAttribute("open", "");
  }

  await expectMobileColumnControls(grid, surface.hasColumnControls);
  return firstRecord;
}

async function expectResponsiveRecordTable(
  surface: ResponsiveDataSurface,
  table: Locator,
): Promise<Locator> {
  await expect(table).toBeVisible({ timeout: 30_000 });
  const firstRecord = table.locator("tbody tr").first();
  await expect(firstRecord).toBeVisible({ timeout: 30_000 });
  const rowHeader = firstRecord.locator('[data-row-header="true"]');
  await expect(rowHeader).toBeVisible();
  expect(await firstRecord.locator("[data-label]").count()).toBe(
    await table.locator("thead th").count(),
  );

  const layout = await table.evaluate((element) => {
    const record = element.querySelector("tbody tr");
    const labeledCell = record?.querySelector<HTMLElement>("[data-label]");
    const rowHeader = record?.querySelector<HTMLElement>(
      '[data-row-header="true"]',
    );
    const wrapper = element.parentElement;
    return {
      tableDisplay: getComputedStyle(element).display,
      tableWidth: element.getBoundingClientRect().width,
      wrapperClientWidth: wrapper?.clientWidth ?? 0,
      wrapperScrollWidth: wrapper?.scrollWidth ?? 0,
      recordDisplay: record ? getComputedStyle(record).display : "missing",
      recordColumns: record
        ? getComputedStyle(record).gridTemplateColumns.split(" ").length
        : 0,
      visibleLabel: labeledCell
        ? getComputedStyle(labeledCell, "::before").content
        : "none",
      rowHeaderWidth: rowHeader?.getBoundingClientRect().width ?? 0,
    };
  });

  expect(layout.wrapperScrollWidth).toBeLessThanOrEqual(
    layout.wrapperClientWidth + 1,
  );
  expect(layout.tableDisplay).toBe("block");
  expect(layout.recordDisplay).toBe("grid");
  expect(layout.recordColumns).toBe(1);
  expect(layout.tableWidth).toBeLessThanOrEqual(430);
  expect(layout.rowHeaderWidth).toBeGreaterThan(0);
  expect(layout.visibleLabel).not.toBe("none");
  expect(layout.visibleLabel).not.toBe('""');

  await expectMobileColumnControls(
    gridForTable(table),
    surface.hasColumnControls,
  );
  return rowHeader;
}

async function expectResponsiveRecordLayout(
  page: Page,
  surface: ResponsiveDataSurface,
  width: number,
): Promise<void> {
  await page.goto(surface.path);
  await expect(page).toHaveURL(
    new RegExp(`${surface.path.replace("/", "\\/")}(?:\\?.*)?$`),
  );
  await expect(page).not.toHaveTitle("");

  const table = surface.table(page);
  await expect(
    surface.layout === "custom" ? gridForTable(table) : surface.surface(page),
  ).toBeVisible();
  const firstRecord =
    surface.layout === "custom"
      ? await expectCustomMobileRecords(page, surface, table)
      : await expectResponsiveRecordTable(surface, table);
  await expectNoPageOverflow(page);
  await firstRecord.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `/tmp/jobctrl-responsive-${surface.name}-${width}.png`,
    fullPage: false,
  });
}

test("@mobile data-heavy routes use task-oriented records at 390px and 430px", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  for (const width of [390, 430] as const) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 932 });
    for (const surface of SURFACES) {
      await expectResponsiveRecordLayout(page, surface, width);
    }
  }

  expect(browserErrors).toEqual([]);
});
