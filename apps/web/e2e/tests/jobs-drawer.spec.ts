import { test, expect } from "@playwright/test";

const FILTER_PARAMS = "stage=all&state=all&deleted=active&sort=fit_score&dir=desc&page=1&pageSize=50";

test("Job drawer: opens with score/stages/artifacts, survives reload, close preserves the URL filter", async ({
  page,
}) => {
  await page.goto(`/jobs?${FILTER_PARAMS}`);
  const row = page
    .locator("table.jobs-data-grid-table tbody tr")
    .filter({ hasText: "Director of Platform Engineering" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();

  await expect(page).toHaveURL(/\/jobs\/.+/);
  const drawer = page.getByRole("dialog", { name: "Job details" });
  await expect(drawer).toBeVisible({ timeout: 10_000 });
  await expect(drawer.getByRole("heading", { name: /Preparation diagnostics/i })).toBeVisible();
  await expect(drawer.getByRole("heading", { name: /Score breakdown/i })).toBeVisible();
  await expect(drawer.getByRole("heading", { name: /Active artifacts/i })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("dialog", { name: "Job details" })).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/sort=fit_score/);

  const closeButton = page.getByRole("button", { name: /close job details/i });
  await closeButton.click();
  await expect(page.getByRole("dialog", { name: "Job details" })).toHaveCount(0);
  await expect(page).toHaveURL(/sort=fit_score/);
  await expect(page).toHaveURL(/\/jobs\?/);
});
