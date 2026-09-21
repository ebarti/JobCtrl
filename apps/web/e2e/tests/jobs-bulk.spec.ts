import { test, expect, type Page } from "@playwright/test";

const ROW_CHECKBOX_SELECTOR =
  "[role='checkbox'][aria-label^='Select ']:not([aria-label='Select all rows on this page'])";

async function showOnlyJobState(
  page: Page,
  state: "Active" | "Deleted" | "Hidden",
): Promise<void> {
  await page
    .getByRole("button", { name: /filter job state column/i })
    .click();
  const dialog = page.getByRole("dialog", { name: "Job state filter" });
  const values = dialog.getByLabel("Job state values");
  for (const option of ["Active", "Deleted", "Hidden"] as const) {
    const checkbox = values.getByRole("checkbox", { name: option });
    if ((await checkbox.isChecked()) !== (option === state)) await checkbox.click();
  }
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
}

test("Bulk soft-delete + restore: select 3 → delete → filter Deleted → restore", async ({
  page,
}) => {
  page.on("dialog", (dialog) => void dialog.accept());

  await page.goto("/jobs");
  await expect(page.getByRole("button", { name: "Select page" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByRole("button", { name: "Select all matching" }),
  ).toBeVisible();
  await expect(page.getByText(/Director of Platform Engineering/i)).toBeVisible(
    {
      timeout: 30_000,
    },
  );
  await expect(page.getByText(/select jobs to manage/i)).toHaveCount(0);

  const rowCheckboxes = page.locator(ROW_CHECKBOX_SELECTOR);
  await expect(rowCheckboxes.first()).toBeVisible({ timeout: 30_000 });
  const rowCount = await rowCheckboxes.count();
  expect(rowCount).toBeGreaterThanOrEqual(3);

  const rowsToSelect = Math.min(3, rowCount);
  for (let i = 0; i < rowsToSelect; i += 1) {
    await rowCheckboxes.nth(i).click();
  }
  await expect(
    page.getByText(new RegExp(`${rowsToSelect} selected`)),
  ).toBeVisible();

  const deleteResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/v1/jobs/bulk-delete") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /delete selected/i }).click();
  expect((await deleteResponse).ok()).toBe(true);
  await expect(
    page.getByText(new RegExp(`${rowsToSelect} selected`)),
  ).toHaveCount(0, { timeout: 15_000 });

  await showOnlyJobState(page, "Deleted");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("jobStates"))
    .toBe('["deleted"]');

  const deletedRowCheckboxes = page.locator(ROW_CHECKBOX_SELECTOR);
  await expect(deletedRowCheckboxes.first()).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => deletedRowCheckboxes.count())
    .toBeGreaterThanOrEqual(rowsToSelect);

  for (let i = 0; i < rowsToSelect; i += 1) {
    await deletedRowCheckboxes.nth(i).click();
  }
  await page.getByRole("button", { name: /restore selected/i }).click();
  await expect(
    page.getByRole("button", { name: /restore selected/i }),
  ).toHaveCount(0, {
    timeout: 15_000,
  });
});

test("Job operations menu hides a selected job and exposes it through the Hidden filter", async ({
  page,
}) => {
  page.on("dialog", (dialog) => void dialog.accept());

  await page.goto("/jobs");
  await expect(page.getByText(/Director of Platform Engineering/i)).toBeVisible({
    timeout: 30_000,
  });

  const selectedCheckbox = page.locator(ROW_CHECKBOX_SELECTOR).first();
  await expect(selectedCheckbox).toBeVisible({ timeout: 30_000 });
  const selectedRowLabel = await selectedCheckbox.getAttribute("aria-label");
  if (!selectedRowLabel) {
    throw new Error("The selected job row must expose a checkbox label.");
  }
  await selectedCheckbox.click();
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();

  const operationsTrigger = page.getByRole("button", {
    name: "Job operations",
  });
  await operationsTrigger.click();
  await expect(operationsTrigger).toHaveAttribute("aria-expanded", "true");

  const operationsMenu = page.getByRole("menu", { name: "Job operations" });
  await expect(operationsMenu).toBeVisible();
  const hideSelected = operationsMenu.getByRole("menuitem", {
    name: "Hide selected",
  });
  await expect(hideSelected).toBeEnabled();
  await hideSelected.click();

  await expect(
    page.getByRole("checkbox", { name: selectedRowLabel }),
  ).toHaveCount(0, { timeout: 15_000 });

  await showOnlyJobState(page, "Hidden");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("jobStates"))
    .toBe('["hidden"]');

  const hiddenCheckbox = page.getByRole("checkbox", {
    name: selectedRowLabel,
  });
  await expect(hiddenCheckbox).toBeVisible({ timeout: 15_000 });

  // Restore the shared E2E fixture so subsequent specs still start from the
  // seeded active queue.
  await hiddenCheckbox.click();
  const unhideSelected = page.getByRole("button", {
    name: "Unhide selected",
  });
  await unhideSelected.click();
  await expect(unhideSelected).toHaveCount(0, { timeout: 15_000 });
  await showOnlyJobState(page, "Active");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("jobStates"))
    .toBe('["active"]');
  await expect(
    page.getByRole("checkbox", { name: selectedRowLabel }),
  ).toBeVisible({ timeout: 15_000 });
});

test("workflow recovery controls stay grouped in Job operations", async ({
  page,
}) => {
  await page.goto("/jobs");
  await expect(page.locator("table.jobs-data-grid-table")).toBeVisible({
    timeout: 30_000,
  });

  const operationsTrigger = page.getByRole("button", {
    name: "Job operations",
  });
  await operationsTrigger.click();
  const operationsMenu = page.getByRole("menu", { name: "Job operations" });
  await expect(operationsMenu).toBeVisible();
  await expect(
    operationsMenu.getByRole("menuitem", {
      name: "Continue pending preparation",
    }),
  ).toBeVisible();
  await expect(
    operationsMenu.getByRole("menuitem", { name: "Retry all failed" }),
  ).toBeVisible();
});
