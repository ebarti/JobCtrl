import { expect, test } from "@playwright/test";

test("Jobs imports a URL or routes an inaccessible page to Manual Capture", async ({ page }) => {
  const jobsResponse = await page.request.get(
    "/v1/jobs?page=1&pageSize=1&sort=discovered_at&dir=desc&deleted=active",
  );
  expect(jobsResponse.ok()).toBe(true);
  const jobs = (await jobsResponse.json()) as {
    items: Array<{ jobKey: string }>;
  };
  const existingJobKey = jobs.items[0]?.jobKey;
  expect(existingJobKey).toBeTruthy();

  await page.route("**/v1/jobs/import-url", async (route) => {
    const body = route.request().postDataJSON() as { url?: string };
    if (body.url?.includes("protected")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          status: "manual_capture_required",
          itemId: "manual:e2e-protected",
          reason: "login_required",
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        status: "imported",
        jobKey: existingJobKey,
        importedAt: "2026-08-13T15:00:00Z",
        alreadyExisted: true,
      }),
    });
  });

  await page.goto("/jobs");
  await page.getByRole("button", { name: "Import job" }).click();
  let dialog = page.getByRole("dialog", { name: "Import a job posting" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Job posting URL" }).fill(
    "https://example.com/jobs/already-imported",
  );
  await dialog.getByRole("button", { name: "Import job" }).click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${existingJobKey}(?:\\?|$)`));

  await page.goto("/jobs");
  await page.getByRole("button", { name: "Import job" }).click();
  dialog = page.getByRole("dialog", { name: "Import a job posting" });
  await dialog.getByRole("textbox", { name: "Job posting URL" }).fill(
    "https://example.com/jobs/protected",
  );
  await dialog.getByRole("button", { name: "Import job" }).click();

  await expect(dialog.getByText(/could not read that page automatically/i)).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Open Manual Capture" })).toHaveAttribute(
    "href",
    "/discovery",
  );
});

test("a second browser tab can import while the first import is still running", async ({
  context,
  page,
}) => {
  const jobsResponse = await page.request.get(
    "/v1/jobs?page=1&pageSize=1&sort=discovered_at&dir=desc&deleted=active",
  );
  expect(jobsResponse.ok()).toBe(true);
  const jobs = (await jobsResponse.json()) as {
    items: Array<{ jobKey: string }>;
  };
  const existingJobKey = jobs.items[0]?.jobKey;
  expect(existingJobKey).toBeTruthy();

  let markFirstStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  let releaseFirst: (() => void) | undefined;
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  await context.route("**/v1/jobs/import-url", async (route) => {
    const body = route.request().postDataJSON() as { url?: string };
    if (body.url?.includes("job-boards.eu.greenhouse.io")) {
      markFirstStarted?.();
      await firstReleased;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        status: "imported",
        jobKey: existingJobKey,
        importedAt: "2026-08-13T15:00:00Z",
        alreadyExisted: true,
      }),
    });
  });

  const secondPage = await context.newPage();
  await Promise.all([page.goto("/jobs"), secondPage.goto("/jobs")]);

  await page.getByRole("button", { name: "Import job" }).click();
  const firstDialog = page.getByRole("dialog", { name: "Import a job posting" });
  await firstDialog.getByRole("textbox", { name: "Job posting URL" }).fill(
    "https://job-boards.eu.greenhouse.io/super/jobs/4939544101",
  );
  await firstDialog.getByRole("button", { name: "Import job" }).click();
  await firstStarted;
  await expect(firstDialog.getByRole("button", { name: "Importing…" })).toBeDisabled();

  await secondPage.getByRole("button", { name: "Import job" }).click();
  const secondDialog = secondPage.getByRole("dialog", { name: "Import a job posting" });
  await secondDialog.getByRole("textbox", { name: "Job posting URL" }).fill(
    "https://www.wave.com/en/careers/job/6129464004/",
  );
  await secondDialog.getByRole("button", { name: "Import job" }).click();
  await expect(secondPage).toHaveURL(new RegExp(`/jobs/${existingJobKey}(?:\\?|$)`));

  await expect(firstDialog).toBeVisible();
  await expect(firstDialog.getByRole("button", { name: "Importing…" })).toBeDisabled();
  releaseFirst?.();
  await expect(page).toHaveURL(new RegExp(`/jobs/${existingJobKey}(?:\\?|$)`));
});
