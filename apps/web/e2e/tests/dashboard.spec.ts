import { test, expect } from "@playwright/test";

test("Dashboard renders KPIs, click 'Jobs' KPI navigates to /jobs and row count matches", async ({
  page,
}) => {
  await page.goto("/dashboard");

  const jobsKpi = page.getByRole("button", { name: /jobs/i }).first();
  await expect(jobsKpi).toBeVisible({ timeout: 30_000 });

  const jobsValueText = await jobsKpi.locator(".kpi-val").innerText();
  const totalJobs = Number.parseInt(jobsValueText.trim(), 10);
  expect(Number.isFinite(totalJobs)).toBe(true);
  expect(totalJobs).toBeGreaterThan(0);

  await jobsKpi.click();
  await expect(page).toHaveURL(/\/jobs\b/);

  const rows = page.locator("table.jobs-data-grid-table tbody tr");
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => rows.count(), { timeout: 30_000 }).toBe(totalJobs);
});
