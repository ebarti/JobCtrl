import type { APIRequestContext, Page } from "@playwright/test";

import { action, completed, expect, json, terminal, test, type ApplicationStack } from "../harness/fixtures.js";
import { baseline, createBaseline } from "./core-data.js";
import { serveRoleTarget } from "./discovery-role-scope-data.js";
import type { FitState } from "./fit-data.js";
import { serveSavedAssessment } from "./search-assessment-data.js";

const targetRole = "Synthetic systems engineer";
const searchPath = "/v1/actions/discovery.search";
const listingPath = "/jobstreaming/linkedin/jobs-guest/jobs/api/seeMoreJobPostings/search";

async function configureSearch(api: APIRequestContext, newJobLimit: number) {
  const setup = await createBaseline(api, { ...baseline, experience: {
    target_role: targetRole, target_locations: "Madrid", target_work_models: "remote",
  } });
  const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", {
    expectedRevision: settings.revision, boards: ["linkedin"], hoursOld: 0, newJobLimit,
  });
  return setup;
}

async function clickSearch(page: Page, name: string) {
  const admitted = page.waitForResponse((response) => new URL(response.url()).pathname === searchPath
    && response.request().method() === "POST");
  await page.getByRole("button", { name, exact: true }).click();
  const response = await admitted;
  expect(response.status()).toBe(202);
  return { response, runId: ((await response.json()) as { runId: string }).runId };
}

function listingCards(ids: readonly number[], fullPage = false) {
  const cards = ids.map((id) => `<div class="base-search-card"><a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/synthetic-engineer-${id}"><span class="sr-only">Synthetic Systems Engineer</span></a><h4 class="base-search-card__subtitle">Synthetic Board Company</h4></div>`);
  return cards.join("") + (fullPage ? '<div class="base-search-card"></div>'.repeat(10 - ids.length) : "");
}

async function listingAt(app: ApplicationStack, start: number) {
  const call = await app.external.next({ timeout: 20_000 });
  const url = new URL(call.path, "http://localhost");
  expect(url.pathname).toBe(listingPath);
  expect(url.searchParams.get("keywords")).toBe(targetRole);
  expect(url.searchParams.get("location")).toBe("Madrid");
  expect(url.searchParams.get("f_WT")).toBe("2");
  expect(Number(url.searchParams.get("start") ?? "0")).toBe(start);
  return call;
}

async function detailFor(app: ApplicationStack, id: number) {
  const call = await app.external.next({ timeout: 20_000 });
  expect(call.path).toBe(`/jobstreaming/linkedin/jobs/view/${id}`);
  return call;
}

function description(text: string) {
  return `<div class="show-more-less-html__markup"><p>${text}</p></div>`;
}

test("Continue LinkedIn search keeps the saved cursor exclusions and remaining job limit", async ({ api, app, page }) => {
  const { library } = await configureSearch(api, 2);
  await page.goto("/jobs");
  const original = await clickSearch(page, "Start search");
  (await listingAt(app, 0)).raw(listingCards([7611, 7612], true));
  (await detailFor(app, 7611)).raw(description("Maintain durable workflow recovery."));
  await serveRoleTarget(app, "match");
  (await detailFor(app, 7612)).raw(description("Audit supplier contracts."));
  await serveRoleTarget(app, "mismatch");
  (await listingAt(app, 10)).raw("Too many requests", { status: 429 });
  await serveSavedAssessment(app, library);

  const prior = (await completed(api, original.runId)).result as { newJobIds: string[] };
  expect(prior).toMatchObject({ status: "partial", newJobs: 1,
    roleTargetObservations: { match: 1, mismatch: 1 },
    failures: [{ code: "discovery_provider_rate_limited" }], preparation: { assessedJobs: 1 },
  });
  const initialJob = prior.newJobIds[0]!;
  const initialFit = await json<FitState>(api, "get", `/v1/jobs/${initialJob}/fit`);
  expect(initialFit).toMatchObject({ current: true, score: { score: 10 } });
  const checkpoint = await app.discoveryCheckpoint(original.runId);
  expect(checkpoint.request.settings.newJobLimit).toBe(2);

  // Even a later change to the normal search limit cannot enlarge this search.
  const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, newJobLimit: 100 });
  await page.reload();
  const progress = page.getByRole("region", { name: "Job search progress" });
  await expect(progress.getByText("While LinkedIn is paused, you can still assess jobs you’ve already saved.", { exact: true })).toBeVisible();
  const continuation = await clickSearch(page, "Continue LinkedIn search");
  expect(continuation.runId).not.toBe(original.runId);
  expect(continuation.response.request().postDataJSON()).toEqual({ resumeFromRunId: original.runId });
  await expect(page.getByRole("button", { name: "Continue LinkedIn search", exact: true })).toHaveCount(0);

  // The provider repeats both rows from the prior page. Its excluded row was
  // never saved to Jobs, so deduplicating only the Jobs table cannot skip it.
  (await listingAt(app, 10)).raw(listingCards([7611, 7612, 7613, 7614]));
  (await detailFor(app, 7613)).raw(description("Design systems for controlled operations."));
  await serveRoleTarget(app, "match");
  await serveSavedAssessment(app, library);
  const finished = (await completed(api, continuation.runId)).result as { newJobIds: string[] };
  expect(finished).toMatchObject({ status: "completed", newJobs: 1, preparation: { status: "succeeded", assessedJobs: 1 } });
  expect(finished.newJobIds).toHaveLength(1);
  const newJob = finished.newJobIds[0]!;
  expect(newJob).not.toBe(initialJob);
  expect(await json(api, "get", `/v1/jobs/${newJob}/fit`)).toMatchObject({ current: true, score: { score: 10 } });
  expect((await json<FitState>(api, "get", `/v1/jobs/${initialJob}/fit`)).score).toEqual(initialFit.score);
  expect((await app.discoveryCheckpoint(original.runId)).receiptKeys).toEqual(checkpoint.receiptKeys);
  const saved = await json<{ jobs: { job_id: string }[] }>(api, "get", "/v1/jobs");
  expect(saved.jobs.map((job) => job.job_id).sort()).toEqual([initialJob, newJob].sort());

  const requests = app.external.calls.filter((call) => call.path.startsWith("/jobstreaming/linkedin/"));
  expect(requests.filter((call) => call.path.startsWith(listingPath)).map((call) => Number(new URL(call.path, "http://localhost").searchParams.get("start")))).toEqual([0, 10, 10]);
  expect(requests.filter((call) => call.path.includes("/jobs/view/")).map((call) => call.path.split("/").at(-1))).toEqual(["7611", "7612", "7613"]);
  expect(app.external.calls.filter((call) => call.path === "/model" && call.body?.["operation"] === "discovery.role_target_match")).toHaveLength(3);
  await page.reload();
  await expect(progress.getByRole("heading", { name: "Search completed", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue LinkedIn search", exact: true })).toHaveCount(0);
});

test("a short positive LinkedIn Retry-After resumes the same detail automatically", async ({ api, app }) => {
  const { profile, library } = await configureSearch(api, 1);
  const search = await action(api, "discovery.search", { queries: [], locations: [], expectedProfileVersion: profile.profileVersion });
  (await listingAt(app, 0)).raw(listingCards([7621]));
  const first = await detailFor(app, 7621);
  const throttledAt = performance.now();
  first.raw("Too many requests", { status: 429, headers: { "Retry-After": "6" } });
  const retry = await detailFor(app, 7621);
  expect(performance.now() - throttledAt).toBeGreaterThanOrEqual(5_900);
  retry.raw(description("Maintain durable workflow recovery."));
  await serveRoleTarget(app, "match");
  await serveSavedAssessment(app, library);

  expect((await completed(api, search.runId)).result).toMatchObject({ status: "completed", newJobs: 1,
    preparation: { status: "succeeded", assessedJobs: 1 } });
  const throttle = await json<{ events: { payload: unknown }[] }>(api, "get",
    `/v1/events?aggregateId=${search.runId}&type=DiscoverySourceRateLimited`);
  expect(throttle.events.map((event) => event.payload)).toEqual([expect.objectContaining({
    phase: "detail", responses: { listing: 1, detail: 1, other: 0 }, retryAfterSeconds: 6,
  })]);
  expect(app.external.calls.filter((call) => call.path.startsWith("/jobstreaming/linkedin/"))).toHaveLength(3);
});

test("LinkedIn continuation skips already checked postings within an interrupted page", async ({ api, app }) => {
  const { profile, library } = await configureSearch(api, 2);
  const first = await action(api, "discovery.search", { queries: [], locations: [], expectedProfileVersion: profile.profileVersion });
  (await listingAt(app, 0)).raw(listingCards([7631, 7632, 7633]));
  (await detailFor(app, 7631)).raw(description("Maintain durable workflow recovery."));
  await serveRoleTarget(app, "match");
  (await detailFor(app, 7632)).raw(description("Audit supplier contracts."));
  await serveRoleTarget(app, "mismatch");
  (await detailFor(app, 7633)).raw("Too many requests", { status: 429 });
  await serveSavedAssessment(app, library);
  const prior = (await completed(api, first.runId)).result as { newJobIds: string[] };
  expect(prior).toMatchObject({ status: "partial", newJobs: 1, preparation: { status: "succeeded", assessedJobs: 1 } });

  const resumed = await action(api, "discovery.search", { resumeFromRunId: first.runId });
  (await listingAt(app, 0)).raw(listingCards([7631, 7632, 7633]));
  (await detailFor(app, 7633)).raw(description("Design systems for controlled operations."));
  await serveRoleTarget(app, "match");
  await serveSavedAssessment(app, library);
  const finished = (await completed(api, resumed.runId)).result as { newJobIds: string[] };
  expect(finished).toMatchObject({ newJobs: 1, preparation: { status: "succeeded", assessedJobs: 1 } });
  expect(finished.newJobIds).toHaveLength(1);
  expect(finished.newJobIds[0]).not.toBe(prior.newJobIds[0]);
  expect(app.external.calls.filter((call) => call.path.includes("/jobstreaming/linkedin/jobs/view/")).map((call) => call.path.split("/").at(-1)))
    .toEqual(["7631", "7632", "7633", "7633"]);
  expect(app.external.calls.filter((call) => call.path === "/model" && call.body?.["operation"] === "discovery.role_target_match")).toHaveLength(3);
});

test("a long LinkedIn Retry-After refuses continuation before sending any request", async ({ api, app }) => {
  const { profile } = await configureSearch(api, 2);
  const search = await action(api, "discovery.search", { queries: [], locations: [], expectedProfileVersion: profile.profileVersion });
  (await listingAt(app, 0)).raw("Too many requests", { status: 429, headers: { "Retry-After": "601" } });
  expect((await terminal(api, search.runId)).status).toBe("failed");
  const refused = await api.post(searchPath, { data: { resumeFromRunId: search.runId } });
  expect(refused.status()).toBe(409);
  const body = (await refused.json()) as { error: { code: string; details: { retryAfterSeconds: number } } };
  expect(body.error.code).toBe("discovery_retry_too_early");
  expect(Number.isInteger(body.error.details.retryAfterSeconds)).toBe(true);
  expect(body.error.details.retryAfterSeconds).toBeGreaterThan(0);
  expect(body.error.details.retryAfterSeconds).toBeLessThanOrEqual(601);
  const { runs } = await json<{ runs: { runId: string }[] }>(api, "get", "/v1/action-runs?action=discovery.search");
  expect(runs.map((row) => row.runId)).toEqual([search.runId]);
  expect(app.external.calls.filter((call) => call.path.startsWith("/jobstreaming/linkedin/"))).toHaveLength(1);
});
