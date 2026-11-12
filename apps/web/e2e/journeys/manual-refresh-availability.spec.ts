import { test, expect, json } from "../harness/fixtures.js";
import { createPosting } from "./core-data.js";

test("Jobs retain the selected opportunity and preparation mode through first Profile setup without automatic model work", async ({
  api,
  app,
  page,
}, testInfo) => {
  expect(
    (await json<{ profileVersion: number | null }>(api, "get", "/v1/profile"))
      .profileVersion,
  ).toBeNull();
  const posting = await createPosting(api, "before-profile-refresh");
  const before = app.external.calls.length;
  expect(
    (
      await json<{ runs: unknown[] }>(
        api,
        "get",
        "/v1/action-runs?action=fit.refresh",
      )
    ).runs,
  ).toEqual([]);
  const pending = await api.get("/v1/fit/refresh/pending");
  expect(pending.status(), await pending.text()).toBe(200);
  expect(await pending.json()).toEqual({
    profile_id: "default",
    readiness: "profile_required",
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(
    `/jobs/${posting.job_id}?q=Reliability&fit_state=unassessed&posted_known=unknown&jobTab=fit&resumeMode=tailored`,
  );
  const prepare = page.getByRole("region", {
    name: "Prepare resume",
    exact: true,
  });
  await expect(
    prepare.getByRole("button", { name: "Prepare resume", exact: true }),
  ).toBeDisabled();
  await expect(prepare).toContainText(
    "Save your profile before preparing a resume.",
  );
  await expect(
    prepare.getByRole("link", { name: "Open My profile", exact: true }),
  ).toBeVisible();
  await prepare
    .getByRole("combobox", { name: "Resume to prepare", exact: true })
    .selectOption("baseline");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("resumeMode"))
    .toBe("baseline");
  const reviewedSearch = Object.fromEntries(new URL(page.url()).searchParams);
  await page
    .locator("summary")
    .filter({ hasText: /^Update affected matches$/ })
    .click();
  const panel = page.getByRole("region", {
    name: "Affected matches",
    exact: true,
  });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByText("Checking saved match state…", { exact: true }),
  ).toHaveCount(0);
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(panel).toContainText("Save a Profile before updating matches.");
  await expect(
    panel.getByRole("button", { name: "Update affected matches", exact: true }),
  ).toBeDisabled();
  await expect(panel).not.toContainText("Saved changes may affect matches.");
  await expect(panel).not.toContainText("No pending changes are recorded.");
  await panel.scrollIntoViewIfNeeded();
  await testInfo.attach("manual-refresh-before-profile", {
    contentType: "image/png",
    body: await page.screenshot(),
  });
  await prepare
    .getByRole("link", { name: "Open My profile", exact: true })
    .click();
  await expect(page).toHaveURL(/\/profile(?:\?|$)/);
  await expect(
    page.getByRole("heading", { name: "Experience", level: 1, exact: true }),
  ).toBeVisible();
  expect(
    (await json<{ profileVersion: number | null }>(api, "get", "/v1/profile"))
      .profileVersion,
  ).toBeNull();
  expect((await api.get(`/v1/jobs/${posting.job_id}`)).status()).toBe(200);
  await page.getByRole("button", { name: "Add role", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Title", exact: true })
    .fill("Synthetic First Role");
  await page
    .getByRole("textbox", { name: "Company", exact: true })
    .fill("Synthetic First Employer");
  await page
    .getByRole("button", { name: "Add achievement", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Achievement 1", exact: true })
    .fill("Documented recovery ownership and its reviewed delivery process.");
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/v1/profile" &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  const write = await saved;
  expect(write.status(), await write.text()).toBe(200);
  const firstProfile = await json<{
    profileVersion: number;
    profile: {
      resume: {
        experience_entries: {
          id: string;
          title: string;
          achievement_ids: string[];
        }[];
      };
    };
  }>(api, "get", "/v1/profile");
  expect(firstProfile.profileVersion).toBeGreaterThan(0);
  expect(firstProfile.profile.resume.experience_entries).toHaveLength(1);
  expect(firstProfile.profile.resume.experience_entries[0]).toMatchObject({
    title: "Synthetic First Role",
    achievement_ids: [expect.any(String)],
  });
  // A peer-section visit must retain the in-app return context as well.
  await page
    .getByRole("navigation", { name: "My profile sections", exact: true })
    .getByRole("link", { name: "Personal details", exact: true })
    .click();
  await page
    .getByRole("link", { name: /Return to job$/, exact: false })
    .click();
  await expect
    .poll(() => new URL(page.url()).pathname)
    .toBe(`/jobs/${posting.job_id}`);
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(
    reviewedSearch,
  );
  await expect(
    prepare.getByRole("combobox", { name: "Resume to prepare", exact: true }),
  ).toHaveValue("baseline");
  await expect(
    prepare.getByRole("button", { name: "Prepare resume", exact: true }),
  ).toBeEnabled();
  await expect(
    page
      .getByRole("table", { name: "Jobs table", exact: true })
      .locator("tbody tr[aria-selected='true']"),
  ).toHaveCount(1);
  expect(
    (
      await json<{ runs: unknown[] }>(
        api,
        "get",
        "/v1/action-runs?action=fit.refresh",
      )
    ).runs,
  ).toEqual([]);
  expect(
    app.external.calls.slice(before).filter((call) => call.path === "/model"),
  ).toEqual([]);
});
