import { expect, test, type Page } from "@playwright/test";

import {
  makeJobsPage,
  sampleJob,
  sampleSecondaryJob,
} from "../../src/test/fixtures/projections.js";

const longCompany =
  "CON&SEL15 International Engineering Search and Selection Partners";

async function assertDesktopCompanyCell(page: Page) {
  const table = page.locator("table.jobs-data-grid-table");
  await expect(table).toBeVisible();

  const row = table.locator("tbody tr").filter({ hasText: longCompany });
  const companyCell = row.locator('td[data-label="Company"]');
  const company = companyCell.locator(".muted-cell");
  const stateCell = row.locator('td[data-label="Job state"]');
  await expect(company).toHaveText(longCompany);

  const bounds = await company.evaluate((element) => {
    const cell = element.closest("td")!;
    const state = cell.nextElementSibling!;
    const style = getComputedStyle(element);
    return {
      display: style.display,
      overflow: style.overflow,
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
      visibleWidth: element.clientWidth,
      fullWidth: element.scrollWidth,
      textRight: element.getBoundingClientRect().right,
      cellRight: cell.getBoundingClientRect().right,
      stateLeft: state.getBoundingClientRect().left,
    };
  });
  await expect(stateCell).toBeVisible();
  expect(bounds.display).toBe("block");
  expect(bounds.overflow).toBe("hidden");
  expect(bounds.textOverflow).toBe("ellipsis");
  expect(bounds.whiteSpace).toBe("nowrap");
  expect(bounds.fullWidth).toBeGreaterThan(bounds.visibleWidth);
  expect(bounds.textRight).toBeLessThanOrEqual(bounds.cellRight + 1);
  expect(bounds.textRight).toBeLessThanOrEqual(bounds.stateLeft + 1);
  await expect(company).toHaveAttribute("title", longCompany);

  await expect(
    table.locator('td[data-label="Company"] .muted-cell', {
      hasText: "Acme",
    }),
  ).toHaveText("Acme");
  await expect(
    table.locator('td[data-label="Company"] .muted-cell', {
      hasText: "-",
    }),
  ).toHaveText("-");
}

test("Jobs company stays in its column and remains readable at desktop and card widths", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.route(/\/v1\/jobs(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      json: makeJobsPage([
        { ...sampleJob, company: longCompany },
        { ...sampleSecondaryJob, company: "Acme" },
        { ...sampleSecondaryJob, jobKey: "qa-no-company", company: "" },
      ]),
    });
  });

  await page.setViewportSize({ width: 1185, height: 844 });
  await page.goto("/jobs");

  for (const theme of ["light", "dark"] as const) {
    await page.setViewportSize({ width: 1185, height: 844 });
    if (theme === "dark") {
      await page.getByRole("button", { name: "Switch to dark theme" }).click();
    }
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

    for (const width of [1185, 901, 900, 821]) {
      await page.setViewportSize({ width, height: 844 });
      await assertDesktopCompanyCell(page);
      if (width === 1185 && theme === "light") {
        await page.screenshot({
          path: testInfo.outputPath("company-1185-light.png"),
        });
        const table = page.locator("table.jobs-data-grid-table");
        const headers = table.locator("thead th[data-column-id]");
        const companyIndex = (
          await headers.evaluateAll((elements) =>
            elements.map((element) => element.getAttribute("data-column-id")),
          )
        ).indexOf("company");
        const reorder = page.getByRole("button", {
          name: "Reorder Company column",
        });
        await reorder.press("ArrowRight");
        await expect
          .poll(async () =>
            (
              await headers.evaluateAll((elements) =>
                elements.map((element) =>
                  element.getAttribute("data-column-id"),
                ),
              )
            ).indexOf("company"),
          )
          .toBe(companyIndex + 1);
        const movedCompany = table.locator(
          'td[data-label="Company"] .muted-cell',
          { hasText: longCompany },
        );
        const movedBounds = await movedCompany.evaluate((element) => ({
          textRight: element.getBoundingClientRect().right,
          cellRight: element.closest("td")!.getBoundingClientRect().right,
        }));
        expect(movedBounds.textRight).toBeLessThanOrEqual(
          movedBounds.cellRight + 1,
        );
        await reorder.press("ArrowLeft");
        await expect
          .poll(async () =>
            (
              await headers.evaluateAll((elements) =>
                elements.map((element) =>
                  element.getAttribute("data-column-id"),
                ),
              )
            ).indexOf("company"),
          )
          .toBe(companyIndex);

        const column = page.locator(
          'table.jobs-data-grid-table col[data-column-id="company"]',
        );
        const originalWidth = await column.evaluate(
          (element) => element.getBoundingClientRect().width,
        );
        await page
          .getByRole("button", { name: "Resize Company column" })
          .press("Shift+ArrowLeft");
        await expect
          .poll(() =>
            column.evaluate((element) => element.getBoundingClientRect().width),
          )
          .toBeLessThan(originalWidth);
        await assertDesktopCompanyCell(page);
        await page.screenshot({
          path: testInfo.outputPath("company-resized-light.png"),
        });
      }
    }

    for (const width of [820, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const cards = page.getByRole("list", { name: "Jobs" });
      await expect(cards).toBeVisible();
      const company = cards.locator(".job-mobile-row__company", {
        hasText: longCompany,
      });
      await expect(company).toHaveText(longCompany);
      await expect(
        cards.locator(".job-mobile-row__company", { hasText: "Acme" }),
      ).toHaveText("Acme");
      await expect(
        cards.locator(".job-mobile-row__company", {
          hasText: "Unknown company",
        }),
      ).toHaveText("Unknown company");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      if (width === 390 && theme === "light") {
        await company.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: testInfo.outputPath("company-card-390-light.png"),
        });
      }
    }
  }
});
