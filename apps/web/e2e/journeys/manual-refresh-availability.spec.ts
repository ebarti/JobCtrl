import { test, expect, json } from "../harness/fixtures.js";
import { createPosting } from "./core-data.js";

test("Jobs remain usable before Profile creation and manual refresh reports an unavailable source without model work", async ({
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
  await page.goto(`/jobs/${posting.job_id}`);
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
  expect(
    (await json<{ profileVersion: number | null }>(api, "get", "/v1/profile"))
      .profileVersion,
  ).toBeNull();
  expect((await api.get(`/v1/jobs/${posting.job_id}`)).status()).toBe(200);
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
