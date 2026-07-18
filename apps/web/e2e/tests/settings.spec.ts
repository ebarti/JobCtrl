import { test, expect } from "@playwright/test";

test("Settings update: change application concurrency -> save -> reload -> persisted", async ({ page }) => {
  await page.goto("/settings");

  await expect(page.getByLabel("Concurrent applications")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Target role", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Ranking priorities")).toHaveCount(0);
  await expect(page.getByText("Exclusions")).toHaveCount(0);

  const currentValue = await page.getByLabel("Concurrent applications").inputValue();
  const newValue = currentValue === "4" ? "3" : "4";
  await page.getByLabel("Concurrent applications").fill(newValue);

  const saveButton = page.getByRole("button", { name: "Save changes" });
  await expect(saveButton).toBeEnabled({ timeout: 10_000 });
  await saveButton.click();

  await expect(page.getByText(/settings saved/i)).toBeVisible({ timeout: 30_000 });

  await page.reload();
  await expect(page.getByLabel("Concurrent applications")).toHaveValue(newValue, {
    timeout: 30_000,
  });
});

test("Settings pairing: trusted split-port app loads and rotates the extension token", async ({ page }) => {
  await page.goto("/settings/browser");

  const tokenField = page.getByLabel("Extension capability token");
  await expect(tokenField).not.toHaveValue("", { timeout: 30_000 });
  await expect(page.getByText("JobCtrl API request failed: 403 Forbidden", { exact: true })).toHaveCount(0);

  const initialToken = await tokenField.inputValue();
  await page.getByRole("button", { name: "Rotate token" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Confirm rotation below; existing extension pairing will disconnect.",
  );
  await page.getByRole("button", { name: "Confirm rotation and disconnect" }).click();

  await expect(page.getByRole("status")).toHaveText("Token rotated", { timeout: 30_000 });
  await expect.poll(() => tokenField.inputValue()).not.toBe(initialToken);
  await expect(page.getByText("JobCtrl API request failed: 403 Forbidden", { exact: true })).toHaveCount(0);
});
