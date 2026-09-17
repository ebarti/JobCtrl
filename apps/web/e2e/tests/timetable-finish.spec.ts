import { expect, test } from "@playwright/test";
import { getViolations, injectAxe } from "axe-playwright";
import { pipelinesDiscoveringSnapshot } from "../../src/views/pipelines/PipelinesView.fixtures.js";
import {
  makeJobsPage,
  makeWorkflowRunsPage,
  sampleJob,
  sampleSecondaryJob,
} from "../../src/test/fixtures/projections.js";

for (const theme of ["light", "dark"] as const) {
  test(`timetable run stop control remains readable in ${theme}`, async ({
    page,
  }) => {
    await page.route(/\/v1\/workflow-runs(?:\?.*)?$/, (route) =>
      route.fulfill({ json: makeWorkflowRunsPage() }),
    );
    await page.goto("/runs");
    const stop = page
      .getByRole("button", { name: /^Stop workflow run for/ })
      .first();
    await expect(stop).toBeVisible();
    await expect(stop).toBeEnabled();
    if (theme === "dark")
      await page.getByRole("button", { name: "Switch to dark theme" }).click();
    const styles = await stop.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        borderWidth: style.borderTopWidth,
        borderColor: style.borderTopColor,
        color: style.color,
        background: style.backgroundColor,
      };
    });
    expect(styles.borderWidth).toBe("1px");
    expect(styles.borderColor).toBe(styles.color);
    expect(styles.background).not.toBe(styles.color);
    await injectAxe(page);
    for (const hovered of [false, true]) {
      if (hovered) await stop.hover();
      await stop.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
      });
      const violations = await getViolations(page, ".runs-row-actions");
      expect(
        violations.filter((violation) =>
          ["critical", "serious"].includes(violation.impact ?? ""),
        ),
      ).toEqual([]);
    }
  });

  test(`timetable stale scores remain inside Fit without obscuring titles in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.route(/\/v1\/jobs(?:\?.*)?$/, async (route) => {
      await route.fulfill({
        json: makeJobsPage([
          {
            ...sampleJob,
            scoreStaleness: {
              isStale: true,
              staleReason: "scoring_policy_changed",
              currentPolicyVersion: 8,
              targetPolicyVersion: 9,
              markedAt: "2026-04-29T10:07:00+00:00",
              pendingExplicitRescore: true,
            },
          },
          sampleSecondaryJob,
        ]),
      });
    });
    await page.goto("/jobs");
    const badge = page.locator(".jobs-data-grid-table .score-stale-tag");
    await expect(badge).toBeVisible();
    await expect(badge).toContainText("Stale score v8 -> v9");
    if (theme === "dark")
      await page.getByRole("button", { name: "Switch to dark theme" }).click();
    for (const density of ["Compact", "Regular", "Comfortable"]) {
      await page.getByRole("button", { name: density, exact: true }).click();
      const layout = await badge.evaluate((element) => {
        const cell = element.closest("td")!;
        const row = cell.closest("tr")!;
        const title = row.querySelector('th[scope="row"]')!;
        const plainRow = [...row.parentElement!.children].find(
          (other) => other !== row,
        )!;
        return {
          warningRight: element.getBoundingClientRect().right,
          titleLeft: title.getBoundingClientRect().left,
          cellRight: cell.getBoundingClientRect().right,
          overflow: cell.scrollWidth - cell.clientWidth,
          badgeOverflow: element.scrollWidth - element.clientWidth,
          staleHeight: row.getBoundingClientRect().height,
          plainHeight: plainRow.getBoundingClientRect().height,
        };
      });
      expect(layout.warningRight).toBeLessThanOrEqual(layout.cellRight);
      expect(layout.warningRight).toBeLessThanOrEqual(layout.titleLeft);
      expect(layout.overflow).toBeLessThanOrEqual(1);
      expect(layout.badgeOverflow).toBeLessThanOrEqual(1);
      expect(layout.plainHeight).toBeLessThan(layout.staleHeight);
    }
  });

  test(`timetable Jobs defaults fit desktop and retain column controls in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/jobs");
    const table = page.locator("table.jobs-data-grid-table");
    await expect(table).toBeVisible({ timeout: 30_000 });
    if (theme === "dark")
      await page.getByRole("button", { name: "Switch to dark theme" }).click();
    await expect(table.locator("thead th")).toHaveCount(8);
    const heights: number[] = [];
    for (const density of ["Compact", "Regular", "Comfortable"]) {
      await page.getByRole("button", { name: density, exact: true }).click();
      const geometry = await table.evaluate((element) => {
        const row = element.querySelector("tbody tr")!;
        return {
          width: element.getBoundingClientRect().width,
          available: element.parentElement!.clientWidth,
          scrollWidth: element.parentElement!.scrollWidth,
          height: row.getBoundingClientRect().height,
          font: getComputedStyle(row.querySelector("td")!).fontSize,
        };
      });
      expect(geometry.width).toBeLessThanOrEqual(geometry.available + 1);
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.available + 1);
      expect(geometry.font).toBe("14px");
      expect(
        await table
          .locator('tbody td[data-label="Location"]')
          .evaluateAll((cells) =>
            cells.every((cell) => cell.scrollWidth <= cell.clientWidth + 1),
          ),
      ).toBe(true);
      heights.push(geometry.height);
    }
    expect(heights[0]).toBeLessThan(heights[1]!);
    expect(heights[1]).toBeLessThan(heights[2]!);
    await page.getByRole("button", { name: "Configure table columns" }).click();
    const dialog = page.getByRole("dialog", { name: "Columns", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Salary min");
    await expect(dialog).toContainText("Discovered");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".job-mobile-row").first()).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
  });

  test(`timetable configuration ink and section rules in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/profile");
    await expect(page.locator(".profile-disclosure").first()).toBeVisible({
      timeout: 30_000,
    });
    if (theme === "dark")
      await page.getByRole("button", { name: "Switch to dark theme" }).click();
    for (const route of ["/profile", "/settings"]) {
      await page.goto(route);
      const input = page.locator('main input[data-slot="input"]').first();
      await expect(input).toBeVisible();
      const styles = await input.evaluate((element) => ({
        border: getComputedStyle(element).borderTopColor,
        width: getComputedStyle(element).borderTopWidth,
        color: getComputedStyle(element).color,
      }));
      expect(styles.width).toBe("1px");
      expect(styles.border).toBe(styles.color);
      const section = page
        .locator(
          route === "/profile"
            ? ".profile-sections > .form-section"
            : ".config-layout .configuration-section",
        )
        .first();
      await expect(section).toHaveCSS("border-top-width", "2px");
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
  });
}

test("Pipelines stage density and section hierarchy follow timetable tokens", async ({
  page,
}) => {
  await page.route("**/v1/pipeline/operations", (route) =>
    route.fulfill({ json: pipelinesDiscoveringSnapshot }),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/pipelines");
  const stage = page.getByRole("region", { name: "Crawl sources stage" });
  const trigger = stage.getByRole("button", { name: /Crawl sources/i });
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  const heights: number[] = [];
  for (const density of ["Compact", "Regular", "Comfortable"]) {
    await page.getByRole("button", { name: density, exact: true }).click();
    heights.push(
      await trigger.evaluate(
        (element) => element.getBoundingClientRect().height,
      ),
    );
  }
  expect(heights[0]).toBeLessThan(heights[1]!);
  expect(heights[1]).toBeLessThan(heights[2]!);
  await expect(page.locator(".pipeline-live-flow__heading")).toHaveCSS(
    "border-bottom-width",
    "2px",
  );
  await expect(page.locator(".pipeline-operations-inspector > h2")).toHaveCSS(
    "border-bottom-width",
    "2px",
  );
  await expect(
    page.getByRole("button", { name: "Stop discovery", exact: true }),
  ).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await trigger.click();
  await expect(
    stage.getByRole("progressbar", { name: "Stage completion" }),
  ).toBeVisible();
});

test("Submit gates retain full reasons without horizontal scrolling on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/apply-review");
  const gates = page.getByRole("table", { name: "Submit gates", exact: true });
  await expect(gates).toBeVisible({ timeout: 30_000 });
  await expect(gates).toContainText("Approval recorded");
  await expect(gates).toContainText("Dry-run evidence");
  await expect(gates).toContainText("Repeat application protection");
  expect(
    await gates.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  for (const width of [320, 720]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await gates.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
  }
});
