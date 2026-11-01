import { expect, test } from "@playwright/test";

test("another URL can be imported in the same dialog while an accepted import runs", async ({ page }) => {
  const first = { workflowId: "job-url-import-e2e-first", executionId: "11111111-1111-4111-8111-111111111111" };
  const second = { workflowId: "job-url-import-e2e-second", executionId: "22222222-2222-4222-8222-222222222222" };
  const urls: string[] = [];
  let firstFinished = false;
  await page.route("**/v1/jobs/import-url", async (route) => {
    const body = route.request().postDataJSON() as { url: string };
    urls.push(body.url);
    await route.fulfill({ status: 202, json: { ok: true, status: "started", ...(urls.length === 1 ? first : second) } });
  });
  await page.route("**/v1/jobs/import-url/*/*", async (route) => {
    const isFirst = route.request().url().includes(first.executionId);
    await route.fulfill({ json: isFirst && firstFinished
      ? { ok: true, status: "imported", jobKey: "33333333-3333-4333-8333-333333333333", importedAt: "2026-10-24T12:00:00Z", alreadyExisted: false }
      : { ok: true, status: "pending", ...(isFirst ? first : second) } });
  });

  await page.goto("/jobs");
  await page.getByRole("button", { name: "Import job" }).click();
  const dialog = page.getByRole("dialog", { name: "Import a job posting" });
  const input = dialog.getByRole("textbox", { name: "Job posting URL" });
  await input.fill("https://example.test/jobs/first");
  await dialog.getByRole("button", { name: "Import job" }).click();
  await expect(dialog.getByText(/Import accepted and running/)).toBeVisible();
  await expect(input).toHaveValue("");
  await expect(input).toBeEnabled();

  await input.fill("https://example.test/jobs/second");
  await dialog.getByRole("button", { name: "Import job" }).click();
  await expect(dialog.getByRole("link", { name: "View import run" })).toHaveCount(2);
  expect(urls).toEqual(["https://example.test/jobs/first", "https://example.test/jobs/second"]);
  await input.fill("https://example.test/jobs/draft");
  firstFinished = true;
  await expect(dialog.getByRole("button", { name: "View job" })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(input).toHaveValue("https://example.test/jobs/draft");
  await expect(page).toHaveURL(/\/jobs(?:\?|$)/);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Import job" }).click();
  await expect(dialog.getByRole("textbox", { name: "Job posting URL" })).toBeEnabled();
  await expect(dialog.getByRole("link", { name: "View import run" })).toHaveCount(2);
});
