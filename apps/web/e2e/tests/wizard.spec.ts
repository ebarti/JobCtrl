import { expect, test } from "@playwright/test";

test("Resume import upload keeps continuation unavailable until a PDF is selected", async ({
  page,
}) => {
  await page.goto("/profile/import/upload");

  const continueButton = page.getByRole("button", {
    name: "Continue to options",
  });
  await expect(continueButton).toBeDisabled();

  const fileInput = page.getByLabel("Resume PDF");
  const minimalPdf = Buffer.from("%PDF-1.4\n% test resume\n%%EOF\n");
  await fileInput.setInputFiles({
    name: "resume.pdf",
    mimeType: "application/pdf",
    buffer: minimalPdf,
  });

  await expect(continueButton).toBeEnabled({ timeout: 30_000 });
});

for (const guardedPath of [
  "/profile/import/preview",
  "/profile/import/confirm",
] as const) {
  test(`${guardedPath} redirects to upload when the prerequisite is absent`, async ({
    page,
  }) => {
    await page.goto(guardedPath);

    await expect(page).toHaveURL(/\/profile\/import\/upload$/);
    await expect(
      page.getByRole("heading", { name: "Choose your source resume" }),
    ).toBeVisible();
    await expect(page.getByText("Step 1 of 3")).toBeVisible();
  });
}

test("Profile import keeps the upload task in the first mobile viewport @mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/profile/import/upload");

  const progress = page.getByRole("navigation", {
    name: "Resume import steps",
  });
  const uploadTarget = page.locator(".resume-import-target");
  await expect(progress).toBeVisible();
  await expect(uploadTarget).toBeVisible();

  const [progressBox, uploadBox, overflow] = await Promise.all([
    progress.boundingBox(),
    uploadTarget.boundingBox(),
    page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    })),
  ]);

  expect(progressBox?.height).toBeLessThanOrEqual(48);
  expect(uploadBox?.y).toBeLessThan(568);
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  await expect(
    page.getByRole("button", { name: "Continue to options" }),
  ).toBeDisabled();
});

test("Resume import wizard: upload PDF → preview → confirm → exits to /profile", async ({
  page,
}) => {
  await page.goto("/profile/import/upload");

  const fileInput = page.getByLabel("Resume PDF");
  await expect(fileInput).toBeAttached({ timeout: 30_000 });

  const minimalPdf = Buffer.from("%PDF-1.4\n% test resume\n%%EOF\n");
  await fileInput.setInputFiles({
    name: "resume.pdf",
    mimeType: "application/pdf",
    buffer: minimalPdf,
  });

  const nextButton = page.getByRole("button", { name: "Continue to options" });
  await expect(nextButton).toBeEnabled({ timeout: 30_000 });
  await nextButton.click();

  await expect(page).toHaveURL(/\/profile\/import\/preview/);
  await expect(page.getByText(/resume\.pdf/i).first()).toBeVisible({
    timeout: 30_000,
  });

  await page.getByRole("button", { name: "Continue to confirmation" }).click();
  await expect(page).toHaveURL(/\/profile\/import\/confirm/);

  const confirmButton = page.getByRole("button", { name: /confirm import/i });
  await expect(confirmButton).toBeEnabled({ timeout: 30_000 });
  await confirmButton.click();

  await expect(page).toHaveURL(/\/profile(?!\/import)/, { timeout: 30_000 });
});
