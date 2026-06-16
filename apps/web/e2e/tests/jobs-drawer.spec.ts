import { test, expect } from "@playwright/test";

const FILTER_PARAMS = "stage=all&state=all&deleted=active&sort=fit_score&dir=desc&page=1&pageSize=50";

test("Job drawer: opens with requirement fit, stages, artifacts, survives reload, close preserves the URL filter", async ({
  page,
}) => {
  await page.goto(`/jobs?${FILTER_PARAMS}`);
  const row = page
    .locator("table.jobs-data-grid-table tbody tr")
    .filter({ hasText: "Director of Platform Engineering" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  // Row activation is the named per-row "Open" button, not a whole-row click:
  // structural rows stay non-interactive for accessibility.
  await row
    .getByRole("button", { name: /^Open job Director of Platform Engineering/ })
    .click();

  await expect(page).toHaveURL(/\/jobs\/.+/);
  const drawer = page.getByRole("dialog", { name: "Job details" });
  await expect(drawer).toBeVisible({ timeout: 10_000 });
  await expect(drawer.getByRole("heading", { name: /Preparation diagnostics/i })).toBeVisible();
  await expect(drawer.getByRole("heading", { name: /Active artifacts/i })).toBeVisible();
  await expect(drawer.getByRole("heading", { name: /Employer analysis/i })).toBeVisible();
  await expect(drawer.getByText("Requirement fit").first()).toBeVisible();
  await expect(
    drawer.getByLabel("Requirement: Lead platform reliability improvements across critical services."),
  ).toBeVisible();

  await page.reload();
  await expect(page.getByRole("dialog", { name: "Job details" })).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/sort=fit_score/);

  const closeButton = page.getByRole("button", { name: /close job details/i });
  await closeButton.click();
  await expect(page.getByRole("dialog", { name: "Job details" })).toHaveCount(0);
  await expect(page).toHaveURL(/sort=fit_score/);
  await expect(page).toHaveURL(/\/jobs\?/);
});

test("Job drawer: Apply Review handoff preserves the selected job", async ({ page }) => {
  const response = await page.request.get("/v1/apply/review-queue");
  expect(response.ok()).toBeTruthy();
  const queue = (await response.json()) as {
    readonly items?: readonly { readonly jobKey: string; readonly title: string }[];
  };
  const target = queue.items?.[0];
  expect(target, "seeded review queue should contain an item").toBeTruthy();

  await page.goto(`/jobs/${encodeURIComponent(target!.jobKey)}?${FILTER_PARAMS}`);
  const drawer = page.getByRole("dialog", { name: "Job details" });
  await expect(drawer).toBeVisible({ timeout: 30_000 });

  await drawer.getByRole("link", { name: `Open Apply Review for ${target!.title}` }).click();

  await expect(page).toHaveURL(/\/apply-review\?/);
  const applyReviewUrl = new URL(page.url());
  expect(applyReviewUrl.searchParams.get("jobKey")).toBe(target!.jobKey);
  await expect(
    page.getByRole("region", { name: `Review evidence for ${target!.title}` }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page
      .getByRole("complementary", { name: "Application review queue" })
      .getByRole("button", { name: new RegExp(target!.title) }),
  ).toHaveAttribute("aria-pressed", "true");
});
