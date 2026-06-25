import { test, expect } from "@playwright/test";

test("Profile edit + Plate baseline editor: edit a field, save, preview HTML refreshes with a new cache key", async ({
  page,
}) => {
  const previewRequests: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/v1/profile/preview.html")) {
      previewRequests.push(url);
    }
  });

  await page.goto("/profile");

  await expect(page.getByText(/Full name/i).first()).toBeVisible({ timeout: 30_000 });

  await expect(page.getByText("Baseline resume editor", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Plate HTML/CSS editor", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Bold" })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => previewRequests.some((url) => url.includes("/v1/profile/preview.html?v=0")), {
    timeout: 30_000,
  }).toBe(true);

  const fullNameLabel = page.getByText(/Full name/i).first();
  const fullNameInput = fullNameLabel.locator("xpath=following-sibling::input").first();
  await fullNameInput.click();
  await fullNameInput.fill("QA Candidate Updated");

  const saveButton = page.getByRole("button", { name: /^save all$/i });
  await expect(saveButton).toBeEnabled({ timeout: 10_000 });
  await saveButton.click();

  await expect(saveButton).toBeDisabled({ timeout: 30_000 });

  await expect.poll(() => previewRequests.some((url) => url.includes("/v1/profile/preview.html?v=1")), {
    timeout: 30_000,
  }).toBe(true);
});
