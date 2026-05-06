import { test, expect } from "@playwright/test";

test("Profile edit + PDF preview: edit a field, save, iframe src updates with a new cache key", async ({
  page,
}) => {
  await page.goto("/profile");

  await expect(page.getByText(/Full name/i).first()).toBeVisible({ timeout: 30_000 });

  const iframe = page.locator("iframe.pdf-preview-frame");
  await expect(iframe).toBeVisible({ timeout: 30_000 });
  const initialSrc = await iframe.getAttribute("src");
  expect(initialSrc).toBeTruthy();

  const fullNameLabel = page.getByText(/Full name/i).first();
  const fullNameInput = fullNameLabel.locator("xpath=following-sibling::input").first();
  await fullNameInput.click();
  await fullNameInput.fill("QA Candidate Updated");

  const saveButton = page.getByRole("button", { name: /^save all$/i });
  await expect(saveButton).toBeEnabled({ timeout: 10_000 });
  await saveButton.click();

  await expect(saveButton).toBeDisabled({ timeout: 30_000 });

  await expect
    .poll(async () => iframe.getAttribute("src"), { timeout: 30_000 })
    .not.toBe(initialSrc);
});
