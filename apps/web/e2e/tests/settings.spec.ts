import { test, expect } from "@playwright/test";

test("Settings update: change application concurrency -> save -> reload -> persisted", async ({
  page,
}) => {
  await page.goto("/settings");

  await expect(page.getByLabel("Concurrent applications")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByLabel("Target role", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Ranking priorities")).toHaveCount(0);
  await expect(page.getByText("Exclusions")).toHaveCount(0);

  const currentValue = await page
    .getByLabel("Concurrent applications")
    .inputValue();
  const newValue = currentValue === "4" ? "3" : "4";
  await page.getByLabel("Concurrent applications").fill(newValue);

  const saveButton = page.getByRole("button", { name: "Save changes" });
  await expect(saveButton).toBeEnabled({ timeout: 10_000 });
  await saveButton.click();

  await expect(page.getByText(/settings saved/i)).toBeVisible({
    timeout: 30_000,
  });

  await page.reload();
  await expect(page.getByLabel("Concurrent applications")).toHaveValue(
    newValue,
    {
      timeout: 30_000,
    },
  );
});

test("Settings pairing: trusted split-port app loads and rotates the extension token", async ({
  page,
}) => {
  await page.goto("/settings/browser");

  const extensionPanel = page.locator(".extension-pairing-settings");
  const extensionDisclosure = extensionPanel.getByRole("button", {
    name: /Browser extension/i,
  });
  await expect(extensionDisclosure).toHaveAttribute("aria-expanded", "false", {
    timeout: 30_000,
  });
  await extensionDisclosure.click();
  await expect(extensionDisclosure).toHaveAttribute("aria-expanded", "true");

  const tokenField = page.getByLabel("Extension capability token");
  await expect(tokenField).not.toHaveValue("", { timeout: 30_000 });
  await expect(
    page.getByText("JobCtrl API request failed: 403 Forbidden", {
      exact: true,
    }),
  ).toHaveCount(0);

  const initialToken = await tokenField.inputValue();
  await page.getByRole("button", { name: "Rotate token" }).click();
  const rotationStatus = extensionPanel.getByRole("status");
  await expect(rotationStatus).toHaveText(
    "Confirm rotation below; existing extension pairing will disconnect.",
  );
  await page
    .getByRole("button", { name: "Confirm rotation and disconnect" })
    .click();

  await expect(rotationStatus).toHaveText("Token rotated", {
    timeout: 30_000,
  });
  await expect.poll(() => tokenField.inputValue()).not.toBe(initialToken);
  await expect(
    page.getByText("JobCtrl API request failed: 403 Forbidden", {
      exact: true,
    }),
  ).toHaveCount(0);
});
