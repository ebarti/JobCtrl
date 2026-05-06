import { test, expect } from "@playwright/test";

const FILTER_PARAMS = "stage=all&state=all&deleted=active&sort=fit_score&dir=desc&page=1&pageSize=50";

test("Job drawer: opens with score/stages/artifacts, survives reload, close preserves the URL filter", async ({
  page,
}) => {
  await page.goto(`/jobs?${FILTER_PARAMS}`);
  const row = page
    .locator(".table .data-row.job:not(.job-header)")
    .filter({ hasText: "Director of Platform Engineering" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();

  await expect(page).toHaveURL(/\/jobs\/.+/);
  const drawer = page.locator("aside.drawer");
  await expect(drawer).toBeVisible({ timeout: 10_000 });
  await expect(drawer.getByRole("heading", { name: /Stage timeline/i })).toBeVisible();
  await expect(drawer.getByRole("heading", { name: /Score breakdown/i })).toBeVisible();
  await expect(drawer.getByRole("heading", { name: /^Artifacts$/i })).toBeVisible();

  await page.reload();
  await expect(page.locator("aside.drawer")).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/sort=fit_score/);

  const closeButton = page.getByRole("button", { name: /close job details/i });
  await closeButton.click();
  await expect(page.locator("aside.drawer")).toHaveCount(0);
  await expect(page).toHaveURL(/sort=fit_score/);
  await expect(page).toHaveURL(/\/jobs\?/);
});
