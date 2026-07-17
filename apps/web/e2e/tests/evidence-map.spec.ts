import { expect, test } from "@playwright/test";

const PLATFORM_JOB_TITLE = "Director of Platform Engineering";

test("Evidence map: job handoff filters evidence and usage links return to artifacts and jobs", async ({
  page,
}) => {
  await page.goto("/jobs");
  const row = page
    .locator("table.jobs-data-grid-table tbody tr")
    .filter({ hasText: PLATFORM_JOB_TITLE });
  await expect(row).toBeVisible({ timeout: 30_000 });
  const visibleTitle = row
    .locator('[data-slot="title-stack-primary"]')
    .filter({ hasText: new RegExp(`^${PLATFORM_JOB_TITLE}$`) });
  await expect(visibleTitle).toBeVisible();
  await visibleTitle.click();

  const drawer = page.getByRole("article", { name: "Job details" });
  await expect(drawer).toBeVisible({ timeout: 10_000 });
  await drawer.getByRole("button", { name: "Back to jobs" }).click();
  await expect(drawer).toHaveCount(0);

  const keyboardActivation = row.getByRole("button", {
    name: /^Open job Director of Platform Engineering/,
  });
  await keyboardActivation.focus();
  await expect(keyboardActivation).toBeFocused();
  await expect(keyboardActivation).toBeVisible();
  await keyboardActivation.press("Enter");
  await expect(drawer).toBeVisible({ timeout: 10_000 });
  await drawer
    .getByRole("link", { name: `Open evidence map for ${PLATFORM_JOB_TITLE}` })
    .click();

  await expect(page).toHaveURL(/\/evidence-map\?.*job=/);
  await expect(
    page.getByRole("heading", { name: "Career evidence map" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Clear job filter" }),
  ).toBeVisible();

  await page
    .getByRole("navigation", { name: "Evidence entries" })
    .getByRole("link", {
      name: /Owned platform reliability improvements for incident response/i,
    })
    .click();
  await expect(
    page.getByText(
      "Lead platform reliability improvements across critical services.",
    ),
  ).toBeVisible();
  await expect(
    page.locator(".evidence-gap-list strong", {
      hasText: "Improve developer experience and incident-response practices.",
    }),
  ).toBeVisible();

  const artifactUsage = page
    .locator(".evidence-usage-link")
    .filter({
      hasText: "Owned platform reliability improvements for incident response.",
    })
    .first();
  await expect(artifactUsage).toHaveAttribute(
    "href",
    "/artifacts/qa-platform-resume-text",
  );
  await artifactUsage.click();
  await expect(page).toHaveURL(/\/artifacts\/qa-platform-resume-text(?:\?|$)/);

  await page.goBack();
  await expect(page).toHaveURL(/\/evidence-map\?.*job=/);
  const requirementUsage = page
    .locator(".evidence-usage-link")
    .filter({
      hasText:
        "Lead platform reliability improvements across critical services.",
    })
    .first();
  await expect(requirementUsage).toHaveAttribute("href", /\/jobs\/.+/);
  await requirementUsage.click();
  await expect(page).toHaveURL(/\/jobs\/.+/);
});
