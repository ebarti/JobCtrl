import { test, expect } from "@playwright/test";

test("Profile edit + PDF preview: edit a field, save, preview URL updates with a new cache key", async ({
  page,
}) => {
  await page.goto("/profile");

  await expect(page.getByText(/Full name/i).first()).toBeVisible({ timeout: 30_000 });

  const previewLink = page.getByRole("link", { name: /open PDF/i });
  await expect(page.getByText("Resume preview", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(previewLink).toBeVisible({ timeout: 30_000 });
  const initialHref = await previewLink.getAttribute("href");
  expect(initialHref).toContain("/v1/profile/preview.pdf");

  const fullNameLabel = page.getByText(/Full name/i).first();
  const fullNameInput = fullNameLabel.locator("xpath=following-sibling::input").first();
  await fullNameInput.click();
  await fullNameInput.fill("QA Candidate Updated");

  const saveButton = page.getByRole("button", { name: /^save all$/i });
  await expect(saveButton).toBeEnabled({ timeout: 10_000 });
  await saveButton.click();

  await expect(saveButton).toBeDisabled({ timeout: 30_000 });

  await expect
    .poll(async () => previewLink.getAttribute("href"), { timeout: 30_000 })
    .not.toBe(initialHref);
});
