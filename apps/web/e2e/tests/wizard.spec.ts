import { test, expect } from "@playwright/test";

test("Resume import wizard: upload PDF → preview → confirm → exits to /profile", async ({
  page,
}) => {
  await page.goto("/profile/import/upload");

  const fileInput = page.locator("input[type='file']");
  await expect(fileInput).toBeAttached({ timeout: 30_000 });

  const minimalPdf = Buffer.from("%PDF-1.4\n% test resume\n%%EOF\n");
  await fileInput.setInputFiles({
    name: "resume.pdf",
    mimeType: "application/pdf",
    buffer: minimalPdf,
  });

  const nextButton = page.getByRole("button", { name: /^next$/i });
  await expect(nextButton).toBeEnabled({ timeout: 30_000 });
  await nextButton.click();

  await expect(page).toHaveURL(/\/profile\/import\/preview/);
  await expect(page.getByText(/resume\.pdf/i).first()).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: /^next$/i }).click();
  await expect(page).toHaveURL(/\/profile\/import\/confirm/);

  const confirmButton = page.getByRole("button", { name: /confirm import/i });
  await expect(confirmButton).toBeEnabled({ timeout: 30_000 });
  await confirmButton.click();

  await expect(page).toHaveURL(/\/profile(?!\/import)/, { timeout: 30_000 });
});
