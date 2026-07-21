import { test, expect } from "@playwright/test";

import { refreshE2eWorkerHeartbeat } from "../fixtures/e2e-state.js";

test("Dashboard renders KPIs, click 'Jobs' KPI navigates to /jobs and row count matches", async ({
  page,
}) => {
  await page.goto("/dashboard");

  const jobsKpi = page
    .locator(".kpis")
    .getByRole("link", { name: /^Jobs\b/i })
    .first();
  await expect(jobsKpi).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Daily digest" })).toBeVisible();
  await expect(page.getByRole("link", { name: /New matches/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /mark reviewed/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Work status" })).toBeVisible();
  await expect(page.getByText("No stuck work.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Active runs" })).toBeVisible();
  await expect(page.getByRole("button", { name: /in progress DiscoverWorkflow/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent activity" })).toBeVisible();
  await expect(page.getByText("Apply workflow completed")).toBeVisible();

  const jobsValueText = await jobsKpi.locator('[data-slot="stat-value"]').innerText();
  const totalJobs = Number.parseInt(jobsValueText.trim(), 10);
  expect(Number.isFinite(totalJobs)).toBe(true);
  expect(totalJobs).toBeGreaterThan(0);

  const overlappingLegendLabels = await page.evaluate(() => {
    function overlaps(a: DOMRect, b: DOMRect): boolean {
      return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
    }

    return [...document.querySelectorAll(".funnel-row")].flatMap((row) => {
      const bar = row.querySelector(".bar");
      if (!bar) return [];
      const barRect = bar.getBoundingClientRect();
      return [...row.querySelectorAll(".legend > span")]
        .filter((label) => overlaps(barRect, label.getBoundingClientRect()))
        .map((label) => label.textContent?.trim() ?? "");
    });
  });
  expect(overlappingLegendLabels).toEqual([]);

  const funnelBarWidths = await page.evaluate(() =>
    [...document.querySelectorAll(".funnel-row .bar")].map((bar) => bar.getBoundingClientRect().width),
  );
  expect(funnelBarWidths.length).toBeGreaterThanOrEqual(2);
  const firstBarWidth = funnelBarWidths[0];
  if (firstBarWidth === undefined) {
    throw new Error("Expected at least one funnel bar width.");
  }
  for (const width of funnelBarWidths.slice(1)) {
    expect(Math.abs(width - firstBarWidth)).toBeLessThanOrEqual(1);
  }

  await jobsKpi.click();
  await expect(page).toHaveURL(/\/jobs\b/);

  const rows = page.locator("table.jobs-data-grid-table tbody tr");
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => rows.count(), { timeout: 30_000 }).toBe(totalJobs);
});

test("@mobile Dashboard keeps the operational overview in the first viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  refreshE2eWorkerHeartbeat();
  await page.goto("/dashboard");

  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.locator(".kpis").getByRole("link")).toHaveCount(6);
  const conversion = page.getByRole("heading", { name: "Conversion" });
  await expect(conversion).toBeVisible();

  const viewportEvidence = await page.evaluate(() => {
    const conversionHeading = [...document.querySelectorAll("h2")].find(
      (heading) => heading.textContent?.trim() === "Conversion",
    );
    const kpiTargets = [...document.querySelectorAll<HTMLElement>(".kpis a")];
    return {
      conversionTop: conversionHeading?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY,
      innerHeight: window.innerHeight,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      minimumKpiTargetHeight: Math.min(...kpiTargets.map((target) => target.getBoundingClientRect().height)),
    };
  });

  expect(viewportEvidence.conversionTop).toBeLessThan(viewportEvidence.innerHeight);
  expect(viewportEvidence.overflow).toBeLessThanOrEqual(1);
  expect(viewportEvidence.minimumKpiTargetHeight).toBeGreaterThanOrEqual(44);
});
