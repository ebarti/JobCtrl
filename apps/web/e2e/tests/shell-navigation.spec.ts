import { expect, test } from "@playwright/test";

test("desktop route identity and sidebar collapse persist across reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/jobs");

  const breadcrumb = page.getByRole("navigation", { name: "breadcrumb" });
  await expect(breadcrumb).toBeVisible({ timeout: 30_000 });
  await expect(breadcrumb.locator('[data-slot="breadcrumb-item"]')).toHaveText([
    "Pipeline",
    "Jobs",
  ]);
  await expect(
    page.getByRole("heading", { level: 1, name: "Jobs" }),
  ).toBeAttached();

  const shell = page.locator(".app-shell");
  const mainNavigation = page.getByRole("navigation", {
    name: "Main navigation",
  });
  const jobsLink = mainNavigation.getByRole("link", {
    name: "Jobs",
    exact: true,
  });
  const jobsLabel = jobsLink.locator(".side-rail__label");
  const toggle = page.getByTitle("Collapse or expand navigation");

  await expect(shell).toHaveAttribute("data-sidebar-open", "true");
  await expect(toggle).toBeVisible();
  await expect(jobsLink).toBeVisible();
  await expect(jobsLabel).toBeVisible();

  await toggle.click();
  await expect(shell).toHaveAttribute("data-sidebar-open", "false");
  await expect(jobsLink).toBeVisible();
  await expect(jobsLabel).toBeHidden();
  await expect(
    mainNavigation.locator(".side-rail__group-label").first(),
  ).toBeHidden();

  await page.reload();
  await expect(shell).toHaveAttribute("data-sidebar-open", "false");
  await expect(jobsLink).toBeVisible();
  await expect(jobsLabel).toBeHidden();

  await toggle.click();
  await expect(shell).toHaveAttribute("data-sidebar-open", "true");
  await expect(jobsLabel).toBeVisible();
  await expect(
    mainNavigation.locator(".side-rail__group-label").first(),
  ).toBeVisible();
});

test("mobile keeps the navigation sheet trigger", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/jobs");

  const openNavigation = page.getByRole("button", { name: "Open navigation" });
  await expect(openNavigation).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTitle("Collapse or expand navigation")).toBeHidden();

  await page.keyboard.press("Control+b");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await openNavigation.click();
  const navigationSheet = page.getByRole("dialog");
  await expect(navigationSheet).toBeVisible();
  await expect(
    navigationSheet.getByRole("link", { name: "Jobs", exact: true }),
  ).toBeVisible();
  await expect(
    navigationSheet.getByRole("link", { name: "Apply review", exact: true }),
  ).toBeVisible();
});
