import { test, expect } from "@playwright/test";

test("Settings update: change apply concurrency -> save -> reload -> persisted", async ({ page }) => {
  await page.goto("/settings");

  await expect(page.getByLabel("Apply concurrency")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Target role")).toHaveCount(0);
  await expect(page.getByText("Ranking priorities")).toHaveCount(0);
  await expect(page.getByText("Exclusions")).toHaveCount(0);

  const currentValue = await page.getByLabel("Apply concurrency").inputValue();
  const newValue = currentValue === "4" ? "3" : "4";
  await page.getByLabel("Apply concurrency").fill(newValue);

  const saveButton = page.getByRole("button", { name: /^save$/i });
  await expect(saveButton).toBeEnabled({ timeout: 10_000 });
  await saveButton.click();

  await expect(page.getByText(/settings saved/i)).toBeVisible({ timeout: 30_000 });

  await page.reload();
  await expect(page.getByLabel("Apply concurrency")).toHaveValue(newValue, { timeout: 30_000 });
});
