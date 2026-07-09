import { test, expect } from "@playwright/test";

const ROW_CHECKBOX_SELECTOR =
  "input[type='checkbox'][aria-label^='Select ']:not([aria-label='Select all rows on this page'])";

test("Bulk soft-delete + restore: select 3 → delete → confirm → switch to deleted tab → restore", async ({
  page,
}) => {
  page.on("dialog", (dialog) => void dialog.accept());

  await page.goto("/jobs");
  await expect(page.getByRole("button", { name: /select page/i })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/Director of Platform Engineering/i)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/select jobs to manage/i)).toHaveCount(0);

  const rowCheckboxes = page.locator(ROW_CHECKBOX_SELECTOR);
  await expect(rowCheckboxes.first()).toBeVisible({ timeout: 30_000 });
  const rowCount = await rowCheckboxes.count();
  expect(rowCount).toBeGreaterThanOrEqual(3);

  const rowsToSelect = Math.min(3, rowCount);
  for (let i = 0; i < rowsToSelect; i += 1) {
    await rowCheckboxes.nth(i).check();
  }
  await expect(page.getByText(new RegExp(`${rowsToSelect} selected`))).toBeVisible();

  await page.getByRole("button", { name: /delete selected/i }).click();
  await expect(page.getByRole("button", { name: /delete selected/i })).toBeDisabled({
    timeout: 15_000,
  });

  await page.getByRole("radio", { name: /^deleted$/i }).click();
  await expect(page).toHaveURL(/deleted=deleted/);

  const deletedRowCheckboxes = page.locator(ROW_CHECKBOX_SELECTOR);
  await expect(deletedRowCheckboxes.first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => deletedRowCheckboxes.count()).toBeGreaterThanOrEqual(rowsToSelect);

  for (let i = 0; i < rowsToSelect; i += 1) {
    await deletedRowCheckboxes.nth(i).check();
  }
  await page.getByRole("button", { name: /restore selected/i }).click();
  await expect(page.getByRole("button", { name: /restore selected/i })).toBeDisabled({
    timeout: 15_000,
  });
});
