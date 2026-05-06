import { test, expect } from "@playwright/test";

test("Settings update: change target role → save → reload → persisted", async ({ page }) => {
  await page.goto("/settings");

  const targetRoleLabel = page.getByText(/^Target role$/i).first();
  await expect(targetRoleLabel).toBeVisible({ timeout: 30_000 });
  const targetRoleInput = targetRoleLabel.locator("xpath=following-sibling::input").first();
  await expect(targetRoleInput).toBeVisible();

  const newValue = `QA Updated Role ${Date.now()}`;
  await targetRoleInput.click();
  await targetRoleInput.fill(newValue);

  const saveButton = page.getByRole("button", { name: /^save$/i });
  await expect(saveButton).toBeEnabled({ timeout: 10_000 });
  await saveButton.click();

  await expect(page.getByText(/settings saved/i)).toBeVisible({ timeout: 30_000 });

  await page.reload();
  await expect(page.getByText(/^Target role$/i).first()).toBeVisible({ timeout: 30_000 });
  const reloadedInput = page.getByText(/^Target role$/i).first().locator("xpath=following-sibling::input").first();
  await expect(reloadedInput).toHaveValue(newValue, { timeout: 30_000 });
});
