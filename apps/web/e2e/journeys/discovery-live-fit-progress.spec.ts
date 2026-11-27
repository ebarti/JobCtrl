import { action, expect, json, test } from "../harness/fixtures.js";
import { createBaseline } from "./core-data.js";
import { indeedPage } from "./indeed-data.js";

test("Jobs shows active and queued Fit work while the search is still acquiring postings", async ({ api, app, page }) => {
  const { profile } = await createBaseline(api);
  const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings",
    { expectedRevision: settings.revision, boards: ["indeed"], hoursOld: 0, newJobLimit: 5 });
  await page.goto("/jobs");

  const search = await action(api, "discovery.search", {
    queries: ["Synthetic engineer"], locations: [{ location: "Madrid" }], boards: ["indeed"],
    expectedProfileVersion: profile.profileVersion, newJobLimit: 5,
  });
  const source = await app.external.next({ match: (call) => call.path === "/jobstreaming/indeed" });
  const postings = Array.from({ length: 4 }, (_, index) => ({
    job_key: `live-fit-progress-${index}`,
    title: `Synthetic Engineer ${index + 1}`,
    company: "Synthetic Board Company",
    location: "Madrid",
  }));
  source.respond(indeedPage({ jobs: postings, cursor: "next-live-fit-page", complete: false }));
  const postingCheck = await app.external.next({ match: (call) => call.path === "/posting-page" });
  const nextPage = await app.external.next({ match: (call) => call.path === "/jobstreaming/indeed" });

  const run = () => json<{ cohortFrozen: boolean; jobIds: string[] }>(api, "get", `/v1/preparation/runs/${search.runId}`);
  await expect.poll(async () => (await run()).jobIds.length).toBe(4);
  expect(await run()).toMatchObject({ status: "running", cohortFrozen: false });
  const running = page.getByRole("table", { name: "Jobs table" }).getByRole("row").filter({
    has: page.getByRole("link", { name: "Checking the job", exact: true }),
  });
  const queued = page.getByRole("table", { name: "Jobs table" }).getByRole("link", { name: "Fit queued", exact: true });
  await expect(running.first()).toBeVisible();
  await expect(queued.first()).toBeVisible();
  await running.first().getByRole("link", { name: /Synthetic Engineer/ }).click();
  await expect(page.getByRole("definition").filter({ hasText: "Checking the job" })).toBeVisible();

  await json(api, "post", `/v1/action-runs/${search.runId}/cancel`, {});
  if (!postingCheck.closed) postingCheck.respond({ error: "Synthetic work stopped" }, 503);
  if (!nextPage.closed) nextPage.respond(indeedPage({ jobs: [], cursor: null, complete: true }));
});
