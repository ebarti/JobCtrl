import { test, expect } from "@playwright/test";

test("Dashboard renders KPIs, click 'Jobs' KPI navigates to /jobs and row count matches", async ({
  page,
}) => {
  await page.goto("/dashboard");

  const jobsKpi = page.locator(".kpis").getByRole("link", { name: /^Jobs\b/i }).first();
  await expect(jobsKpi).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Daily digest" })).toBeVisible();
  await expect(page.getByRole("link", { name: /New matches/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /mark reviewed/i })).toBeVisible();

  const jobsValueText = await jobsKpi.locator(".kpi-val").innerText();
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
