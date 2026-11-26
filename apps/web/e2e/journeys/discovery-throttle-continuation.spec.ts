import type { APIRequestContext, Page, Response } from "@playwright/test";

import { action, completed, expect, json, terminal, test, type ApplicationStack, type ExternalCall } from "../harness/fixtures.js";
import { baseline, createBaseline } from "./core-data.js";
import { serveRoleTarget } from "./discovery-role-scope-data.js";
import type { FitState } from "./fit-data.js";
import { linkedinCard } from "./linkedin-data.js";
import { serveQualification, serveSavedAssessment } from "./search-assessment-data.js";

const targetRole = "Synthetic systems engineer";
const searchPath = "/v1/actions/discovery.search";
const listingPath = "/jobstreaming/linkedin/jobs-guest/jobs/api/seeMoreJobPostings/search";

// Independent Fit and Discovery queues can reach different external boundaries concurrently.
function modelStream(app: ApplicationStack, match: (call: ExternalCall) => boolean): ApplicationStack {
  return { ...app, external: { ...app.external, next: (options) => app.external.next({ ...options, match }) } };
}

function roleModel(app: ApplicationStack) {
  return modelStream(app, (call) => call.path === "/model" && call.body["operation"] === "discovery.role_target_match");
}

function assessmentModel(app: ApplicationStack) {
  return modelStream(app, (call) => call.path === "/model" && call.body["operation"] !== "discovery.role_target_match");
}

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

async function startSearch(page: Page) {
  const admitted = page.waitForResponse((response) => new URL(response.url()).pathname === searchPath
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Start search", exact: true }).click();
  const response = await admitted;
  expect(response.status()).toBe(202);
  return await response.json() as { runId: string };
}

function listingCards(ids: readonly number[], fullPage = false) {
  const cards = ids.map(linkedinCard);
  return cards.join("") + (fullPage ? '<div class="base-search-card"></div>'.repeat(10 - ids.length) : "");
}

async function listingAt(app: ApplicationStack, start: number) {
  const call = await app.external.next({ timeout: 30_000, match: (call) => call.path.startsWith(listingPath) });
  const url = new URL(call.path, "http://localhost");
  expect(url.pathname).toBe(listingPath);
  expect(url.searchParams.get("keywords")).toBe(targetRole);
  expect(url.searchParams.get("location")).toBe("Madrid");
  expect(url.searchParams.get("f_WT")).toBe("2");
  expect(Number(url.searchParams.get("start") ?? "0")).toBe(start);
  return call;
}

async function detailFor(app: ApplicationStack, id: number) {
  const call = await app.external.next({ timeout: 30_000, match: (call) => call.path === `/jobstreaming/linkedin/jobs/view/${id}` });
  expect(call.path).toBe(`/jobstreaming/linkedin/jobs/view/${id}`);
  return call;
}

function description(text: string) {
  return `<div class="show-more-less-html__markup"><p>${text}</p></div>`;
}

type Throttle = { receivedAt: string; retryAtEpochSeconds: number; retryAfterSeconds: number | null; phase: string };

async function throttleEvents(api: APIRequestContext, runId: string) {
  const { events } = await json<{ events: { payload: Throttle }[] }>(api, "get",
    `/v1/events?aggregateId=${runId}&type=DiscoverySourceRateLimited`);
  // Activity history is newest first. Compare waits in request order.
  return events.reverse().map((event) => event.payload);
}

function plannedWaitMs(throttle: Throttle) {
  return Math.trunc(throttle.retryAtEpochSeconds * 1000) - Date.parse(throttle.receivedAt);
}

test("LinkedIn automatically resumes a throttled page with the original exclusions and remaining job limit", async ({ api, app, context, page }) => {
  const { library } = await configureSearch(api, 2);
  await page.goto("/jobs");
  const original = await startSearch(page);
  (await listingAt(app, 0)).raw(listingCards([7611, 7612], true));
  (await detailFor(app, 7611)).raw(description("Maintain durable workflow recovery."));
  await serveRoleTarget(roleModel(app), "match");
  const assessment = serveSavedAssessment(assessmentModel(app), library);
  (await detailFor(app, 7612)).raw(description("Audit supplier contracts."));
  await serveRoleTarget(roleModel(app), "mismatch");
  (await listingAt(app, 10)).raw("Too many requests", { status: 429 });
  await assessment;

  const accepted = await json<{ jobs: { job_id: string }[] }>(api, "get", "/v1/jobs");
  expect(accepted.jobs).toHaveLength(1);
  const initialJob = accepted.jobs[0]!.job_id;
  await expect.poll(async () => (await json<FitState>(api, "get", `/v1/jobs/${initialJob}/fit`)).current).toBe(true);
  const initialFit = await json<FitState>(api, "get", `/v1/jobs/${initialJob}/fit`);
  expect(initialFit).toMatchObject({ current: true, score: { score: 10 } });
  const checkpoint = await app.discoveryCheckpoint(original.runId);
  expect(checkpoint.request.settings.newJobLimit).toBe(2);

  // Even a later change to the normal search limit cannot enlarge this search.
  const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, newJobLimit: 100 });
  await page.reload();
  const progress = page.getByRole("region", { name: "Job search progress" });
  await expect(progress.getByRole("button", { name: "Request stop", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue LinkedIn search", exact: true })).toHaveCount(0);
  await page.close();

  // The provider repeats both rows from the prior page. Its excluded row was
  // never saved to Jobs, so deduplicating only the Jobs table cannot skip it.
  (await listingAt(app, 10)).raw(listingCards([7611, 7612, 7613, 7614]));
  (await detailFor(app, 7613)).raw(description("Design systems for controlled operations."));
  await serveRoleTarget(roleModel(app), "match");
  await serveSavedAssessment(assessmentModel(app), library);
  const finished = (await completed(api, original.runId)).result as { newJobIds: string[] };
  expect(finished).toMatchObject({ status: "completed", newJobs: 2, failures: [],
    roleTargetObservations: { match: 2, mismatch: 1 }, preparation: { status: "succeeded", assessedJobs: 2 } });
  expect(finished.newJobIds).toHaveLength(2);
  expect(finished.newJobIds).toContain(initialJob);
  const newJob = finished.newJobIds.find(id => id !== initialJob)!;
  expect(await json(api, "get", `/v1/jobs/${newJob}/fit`)).toMatchObject({ current: true, score: { score: 10 } });
  expect((await json<FitState>(api, "get", `/v1/jobs/${initialJob}/fit`)).score).toEqual(initialFit.score);
  const finalCheckpoint = await app.discoveryCheckpoint(original.runId);
  expect(finalCheckpoint.receiptKeys).toEqual(expect.arrayContaining(checkpoint.receiptKeys));
  expect(finalCheckpoint.request).toEqual(checkpoint.request);
  const saved = await json<{ jobs: { job_id: string }[] }>(api, "get", "/v1/jobs");
  expect(saved.jobs.map((job) => job.job_id).sort()).toEqual([initialJob, newJob].sort());

  const requests = app.external.calls.filter((call) => call.path.startsWith("/jobstreaming/linkedin/"));
  expect(requests.filter((call) => call.path.startsWith(listingPath)).map((call) => Number(new URL(call.path, "http://localhost").searchParams.get("start")))).toEqual([0, 10, 10]);
  expect(requests.filter((call) => call.path.includes("/jobs/view/")).map((call) => call.path.split("/").at(-1))).toEqual(["7611", "7612", "7613"]);
  expect(app.external.calls.filter((call) => call.path === "/model" && call.body?.["operation"] === "discovery.role_target_match")).toHaveLength(3);
  const reopened = await context.newPage();
  await reopened.goto("/jobs");
  await expect(reopened.getByRole("heading", { name: "Search completed", exact: true })).toBeVisible();
  await expect(reopened.getByRole("button", { name: "Continue LinkedIn search", exact: true })).toHaveCount(0);
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
  await serveRoleTarget(roleModel(app), "match");
  await serveSavedAssessment(assessmentModel(app), library);

  expect((await completed(api, search.runId)).result).toMatchObject({ status: "completed", newJobs: 1,
    preparation: { status: "succeeded", assessedJobs: 1 } });
  const throttle = await json<{ events: { payload: unknown }[] }>(api, "get",
    `/v1/events?aggregateId=${search.runId}&type=DiscoverySourceRateLimited`);
  expect(throttle.events.map((event) => event.payload)).toEqual([expect.objectContaining({
    phase: "detail", responses: { listing: 1, detail: 1, other: 0 }, retryAfterSeconds: 6,
  })]);
  expect(app.external.calls.filter((call) => call.path.startsWith("/jobstreaming/linkedin/"))).toHaveLength(3);
});

test("repeated LinkedIn detail throttles back off across worker replacement and resume the same posting", async ({ api, app }) => {
  const { profile, library } = await configureSearch(api, 2);
  const first = await action(api, "discovery.search", { queries: [], locations: [], expectedProfileVersion: profile.profileVersion });
  (await listingAt(app, 0)).raw(listingCards([7631, 7632, 7633]));
  (await detailFor(app, 7631)).raw(description("Maintain durable workflow recovery."));
  await serveRoleTarget(roleModel(app), "match");
  const assessment = serveSavedAssessment(assessmentModel(app), library);
  (await detailFor(app, 7632)).raw(description("Audit supplier contracts."));
  await serveRoleTarget(roleModel(app), "mismatch");
  const blocked = await detailFor(app, 7633);
  const firstLimitAt = performance.now();
  blocked.raw("Too many requests", { status: 429 });
  const retry = await detailFor(app, 7633);
  expect(performance.now() - firstLimitAt).toBeGreaterThanOrEqual(4_000);
  const secondLimitAt = performance.now();
  retry.raw("Too many requests", { status: 429, headers: { "Retry-After": "unknown" } });
  const nextDetail = detailFor(app, 7633).then(call => ({ call, arrivedAt: performance.now() }));
  await assessment;
  await expect.poll(async () => {
    const history = await json<{ runs: { runId: string; cooldowns: { retryAfterSeconds: number }[] }[] }>(api, "get", "/v1/discovery/runs");
    return history.runs.find(run => run.runId === first.runId)?.cooldowns[0]?.retryAfterSeconds ?? 0;
  }).toBeGreaterThan(4);
  const pids = await app.restartWorker();
  expect(pids.current).not.toBe(pids.previous);
  const { call, arrivedAt } = await nextDetail;
  expect(arrivedAt - secondLimitAt).toBeGreaterThanOrEqual(8_000);
  call.raw(description("Design systems for controlled operations."));
  await serveRoleTarget(roleModel(app), "match");
  await serveSavedAssessment(assessmentModel(app), library);
  const finished = (await completed(api, first.runId)).result as { newJobIds: string[] };
  expect(finished).toMatchObject({ status: "completed", failures: [], newJobs: 2, preparation: { status: "succeeded", assessedJobs: 2 } });
  expect(new Set(finished.newJobIds).size).toBe(2);
  const throttles = await throttleEvents(api, first.runId);
  expect(throttles.map(event => [event.phase, event.retryAfterSeconds])).toEqual([["detail", null], ["detail", null]]);
  const waits = throttles.map(plannedWaitMs);
  expect(waits[0]).toBeGreaterThanOrEqual(4_000);
  expect(waits[0]).toBeLessThanOrEqual(8_000);
  expect(waits[1]).toBeGreaterThanOrEqual(8_000);
  expect(waits[1]).toBeLessThanOrEqual(16_000);
  await test.info().attach("fallback-waits", { contentType: "application/json", body: JSON.stringify({ waitsMs: waits }) });
  expect(app.external.calls.filter((call) => call.path.includes("/jobstreaming/linkedin/jobs/view/")).map((call) => call.path.split("/").at(-1)))
    .toEqual(["7631", "7632", "7633", "7633", "7633"]);
  expect(app.external.calls.filter((call) => call.path === "/model" && call.body?.["operation"] === "discovery.role_target_match")).toHaveLength(3);
});

test("a long source cooldown survives worker replacement while one failed Fit can be retried from Jobs", async ({ api, app, page, allowResponseError }) => {
  const { profile, library } = await configureSearch(api, 2);
  const search = await action(api, "discovery.search", { queries: [], locations: [], expectedProfileVersion: profile.profileVersion });
  (await listingAt(app, 0)).raw(listingCards([7641, 7642]));
  (await detailFor(app, 7641)).raw(description("Maintain durable workflow recovery."));
  await serveRoleTarget(roleModel(app), "match");
  const assessment = serveSavedAssessment(assessmentModel(app), library, { invalidEvidence: true });
  (await detailFor(app, 7642)).raw("Too many requests", { status: 429, headers: { "Retry-After": "601" } });
  await assessment;
  const recorded = () => json<{ jobIds: string[]; retryableJobIds: string[]; status: string }>(api, "get", `/v1/preparation/runs/${search.runId}`);
  await expect.poll(async () => (await recorded()).retryableJobIds.length).toBe(1);
  const failed = (await recorded()).retryableJobIds[0]!;
  const preRestart = await app.discoveryCheckpoint(search.runId);
  const [throttle] = await throttleEvents(api, search.runId);
  expect(plannedWaitMs(throttle!)).toBe(601_000);
  const before = app.external.calls.map((call) => call.body?.["operation"]);
  const pids = await app.restartWorker();
  expect(pids.current).not.toBe(pids.previous);
  await page.goto("/jobs");
  const progress = page.getByRole("region", { name: "Job search progress" });
  await expect(progress).toContainText("LinkedIn paused this search");
  await expect(progress.locator("time")).toHaveAttribute("datetime", new Date(throttle!.retryAtEpochSeconds * 1000).toISOString());
  await expect(page.getByRole("button", { name: "Continue LinkedIn search", exact: true })).toHaveCount(0);
  expect((await recorded()).status).toBe("running");
  await page.goto(`/jobs/${failed}`);
  const missingLookups: Response[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (response.status() === 404 && url.origin === app.baseURL && url.pathname === "/v1/action-runs/by-idempotency-key"
      && url.search === "?action=preparation.retry") missingLookups.push(response);
  });
  const retry = page.waitForResponse((r) => new URL(r.url()).pathname === "/v1/actions/preparation.retry" && r.request().method() === "POST");
  await page.getByRole("button", { name: "Retry fit assessment for this job", exact: true }).click();
  const receipt = await retry;
  expect(receipt.status()).toBe(202);
  expect(receipt.request().postDataJSON()).toEqual({ run_id: search.runId, job_ids: [failed] });
  const retryHeaders = await receipt.request().allHeaders();
  expect(missingLookups.length).toBeLessThanOrEqual(1);
  for (const lookup of missingLookups) {
    await allowResponseError(lookup, { method: "GET", status: 404, code: "not_found", action: "preparation.retry",
      idempotencyKey: retryHeaders["idempotency-key"]!, databaseInstanceId: retryHeaders["expected-database-instance-id"]! });
  }
  await serveQualification(assessmentModel(app), library);
  await completed(api, (await receipt.json() as { runId: string }).runId);
  const accepted = await json<FitState>(api, "get", `/v1/jobs/${failed}/fit`);
  expect(accepted).toMatchObject({ current: true, score: { score: 10 } });
  expect(accepted.score.assessments[0]!.provenance).toMatchObject({ receipt_id: expect.any(String), lane: "scoring" });
  for (const operation of ["discovery.role_target_match","jobs.role_analysis","requirements.extract","requirements.match_catalog"]) {
    expect(app.external.calls.filter((call) => call.body?.["operation"] === operation)).toHaveLength(before.filter((op) => op === operation).length);
  }
  await page.goto("/jobs");
  await page.getByRole("region", { name: "Job search progress" }).getByRole("button", { name: "Request stop" }).click();
  expect((await terminal(api, search.runId)).status).toBe("cancelled");
  expect((await app.discoveryCheckpoint(search.runId)).adapters).toEqual(preRestart.adapters);
  expect((await json<FitState>(api, "get", `/v1/jobs/${failed}/fit`)).score).toEqual(accepted.score);
  expect(app.external.calls.filter((call) => call.path.startsWith("/jobstreaming/linkedin/"))).toHaveLength(3);
});

test("repeated LinkedIn limits keep the fallback between one and two minutes", async ({ api, app }, info) => {
  const { profile } = await configureSearch(api, 1);
  const search = await action(api, "discovery.search", { queries: [], locations: [], expectedProfileVersion: profile.profileVersion });
  for (let attempt = 0; attempt < 6; attempt++)
    (await listingAt(app, 0)).raw("Too many requests", { status: 429, headers: { "Retry-After": "1" } });
  (await listingAt(app, 0)).raw("Too many requests", { status: 429 });
  await expect.poll(async () => (await throttleEvents(api, search.runId)).length).toBe(7);
  const events = await throttleEvents(api, search.runId);
  expect(events.map(event => event.retryAfterSeconds)).toEqual([1, 1, 1, 1, 1, 1, null]);
  expect(events.slice(0, 6).map(plannedWaitMs)).toEqual(Array(6).fill(4_000));
  const last = events[6]!;
  const wait = plannedWaitMs(last);
  expect(wait).toBeGreaterThanOrEqual(60_000);
  expect(wait).toBeLessThanOrEqual(120_000);
  await expect.poll(async () => {
    const runs = await json<{ runs: { runId: string; cooldowns: { retryAtEpochSeconds: number }[] }[] }>(api, "get", "/v1/discovery/runs");
    return runs.runs.find(run => run.runId === search.runId)?.cooldowns[0]?.retryAtEpochSeconds;
  }).toBe(last.retryAtEpochSeconds);
  await json(api, "post", `/v1/action-runs/${search.runId}/cancel`, {});
  expect((await terminal(api, search.runId)).status).toBe("cancelled");
  await info.attach("capped-fallback", { contentType: "application/json", body: JSON.stringify({ consecutiveLimits: events.length, waitMs: wait }) });
});

test.describe("search timer handoff", () => {
  test.use({ searchTimerDebugger: true });

  test("an overdue search retries on cold startup even if the worker quit before registering its timer", async ({ api, app, context, page, postgres }, info) => {
    const { library } = await configureSearch(api, 1);
    await page.goto("/jobs");
    const original = await startSearch(page);
    (await listingAt(app, 0)).raw("Too many requests", { status: 429, headers: { "Retry-After": "18" } });
    await app.waitForSearchTimerPause(original.runId);
    const [throttle] = await throttleEvents(api, original.runId);
    const deadline = throttle!.retryAtEpochSeconds * 1000;
    expect(plannedWaitMs(throttle!)).toBe(18_000);
    const progress = page.getByRole("region", { name: "Job search progress" });
    const visibleTime = progress.locator("time");
    await expect(visibleTime).toHaveAttribute("datetime", new Date(deadline).toISOString());
    await info.attach("local-retry-time", { contentType: "image/png", body: await progress.screenshot() });
    await page.close();

    let workerStartedAt = 0;
    await app.restartWorker(undefined, async () => {
      await app.restartApi({ afterExit: async () => {
        await postgres.pause();
        try {
          await expect.poll(() => Date.now(), { timeout: 22_000, intervals: [200] }).toBeGreaterThan(deadline);
          expect(app.external.calls.filter(call => call.path.startsWith(listingPath))).toHaveLength(1);
        } finally {
          await postgres.resume();
        }
      } });
      workerStartedAt = Date.now();
    });

    const retry = await listingAt(app, 0);
    const resumedAt = Date.now();
    expect(workerStartedAt).toBeGreaterThan(deadline);
    expect(resumedAt - workerStartedAt).toBeLessThan(12_000);
    retry.raw(listingCards([7651]));
    (await detailFor(app, 7651)).raw(description("Maintain durable workflow recovery."));
    await serveRoleTarget(roleModel(app), "match");
    await serveSavedAssessment(assessmentModel(app), library);
    expect((await completed(api, original.runId)).result).toMatchObject({ status: "completed", newJobs: 1, preparation: { assessedJobs: 1 } });
    expect(await throttleEvents(api, original.runId)).toEqual([throttle]);
    const reopened = await context.newPage();
    await reopened.goto("/jobs");
    await expect(reopened.getByRole("heading", { name: "Search completed", exact: true })).toBeVisible();
    await info.attach("offline-recovery", { contentType: "application/json", body: JSON.stringify({
      promisedWaitMs: plannedWaitMs(throttle!), deadline, workerStartedAt, resumedAt, elapsedFromWorkerStartMs: resumedAt - workerStartedAt,
    }) });
  });
});
