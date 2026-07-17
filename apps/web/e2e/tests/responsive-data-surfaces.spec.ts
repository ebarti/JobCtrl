import { expect, type Locator, type Page, test } from "@playwright/test";

interface ResponsiveDataSurface {
  readonly name: string;
  readonly path: string;
  readonly table: (page: Page) => Locator;
  readonly surface: (page: Page) => Locator;
  readonly hasColumnControls: boolean;
}

const SURFACES: readonly ResponsiveDataSurface[] = [
  {
    name: "jobs",
    path: "/jobs",
    table: (page) => page.locator("table.jobs-data-grid-table"),
    surface: (page) => page.locator(".jobs-data-grid-table").locator(".."),
    hasColumnControls: true,
  },
  {
    name: "artifacts",
    path: "/artifacts",
    table: (page) => page.locator("table.artifacts-data-grid-table"),
    surface: (page) => page.locator(".artifacts-data-grid-table").locator(".."),
    hasColumnControls: true,
  },
  {
    name: "contacts",
    path: "/outreach",
    table: (page) => page.locator("table.contacts-data-grid-table"),
    surface: (page) => page.locator(".contacts-data-grid-table").locator(".."),
    hasColumnControls: true,
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
  },
  {
    name: "settings-compensation-sources",
    path: "/settings",
    table: (page) =>
      page.getByRole("table", { name: "Compensation source policy" }),
    surface: (page) => page.locator(".compensation-source-policy-panel"),
    hasColumnControls: false,
  },
];

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
  await expect(table).toBeVisible({ timeout: 30_000 });
  await expect(surface.surface(page)).toBeVisible();
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
    const documentElement = document.documentElement;
    const wrapper = element.parentElement;
    return {
      documentClientWidth: documentElement.clientWidth,
      documentScrollWidth: documentElement.scrollWidth,
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

  expect(layout.documentScrollWidth).toBeLessThanOrEqual(
    layout.documentClientWidth + 1,
  );
  expect(layout.wrapperScrollWidth).toBeLessThanOrEqual(
    layout.wrapperClientWidth + 1,
  );
  expect(layout.tableDisplay).toBe("block");
  expect(layout.recordDisplay).toBe("grid");
  expect(layout.recordColumns).toBe(width === 390 ? 1 : 2);
  expect(layout.tableWidth).toBeLessThanOrEqual(width);
  expect(layout.rowHeaderWidth).toBeGreaterThan(0);
  expect(layout.visibleLabel).not.toBe("none");
  expect(layout.visibleLabel).not.toBe('""');

  if (surface.hasColumnControls) {
    const grid = table.locator(
      "xpath=ancestor::div[contains(@class,'filterable-data-grid')]",
    );
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

  await rowHeader.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `/tmp/jobctrl-responsive-${surface.name}-${width}.png`,
    fullPage: false,
  });
}

test("@mobile data-heavy routes reflow records at 390px and 768px", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  for (const width of [390, 768] as const) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
    for (const surface of SURFACES) {
      await expectResponsiveRecordLayout(page, surface, width);
    }
  }

  expect(browserErrors).toEqual([]);
});
