import type { APIRequestContext } from "@playwright/test";
import { action, completed, expect, json, terminal, test, type ApplicationStack } from "../harness/fixtures.js";
import { baseline, createBaseline } from "./core-data.js";
import { roleTargetStream, serveRoleTarget } from "./discovery-role-scope-data.js";
import { linkedinCard } from "./linkedin-data.js";

test.use({ features: "profile,jobs,discovery" });

const board = "/jobstreaming/linkedin/";
const listing = board + "jobs-guest/jobs/api/seeMoreJobPostings/search";
const detail = (id: number) => board + "jobs/view/" + id;

async function request(app: ApplicationStack, path: string) {
  const call = await app.external.next({ timeout: 30_000, match: (candidate) => candidate.path.startsWith(board) });
  expect(new URL(call.path, "http://localhost").pathname).toBe(path);
  return call;
}

type Throttle = {
  receivedAt: string; requestedAt: string; retryAtEpochSeconds: number; ordinaryRequestIntervalSeconds: number; retryAfterSeconds: number | null;
  previousRunBoardRequest?: { requestedAt: string; phase: string; httpStatus: number }; requestStartIntervalMs?: number;
};

async function throttleHistory(api: APIRequestContext, run: string) {
  const { events } = await json<{ events: { payload: Throttle }[] }>(api, "get",
    `/v1/events?aggregateId=${run}&type=DiscoverySourceRateLimited`);
  return events.reverse().map((event) => event.payload);
}

test("LinkedIn listing and detail traffic recovers its ordinary spacing after a throttle and worker replacement", async ({ api, app, page }, info) => {
  const { profile } = await createBaseline(api, { ...baseline, experience: { target_role: "Synthetic engineer", target_locations: "Madrid" } });
  await json(api, "post", "/v1/jobs/capture", { url: "https://www.linkedin.com/jobs/view/7970",
    title: "Synthetic Systems Engineer", company: "Synthetic Board Company", description: "An already saved posting." });
  await page.goto("/jobs");
  const search = await action(api, "discovery.search", { queries: [], locations: [], boards: ["linkedin"], hoursOld: 0,
    newJobLimit: 8, expectedProfileVersion: profile.profileVersion });
  (await request(app, listing)).raw("Busy", { status: 429, headers: { "Retry-After": "8" } });
  await expect.poll(async () => (await throttleHistory(api, search.runId)).length).toBe(1);
  const [throttle] = await throttleHistory(api, search.runId);
  await expect(page.getByRole("region", { name: "Job search progress" }).getByRole("button", { name: "Request stop" })).toBeVisible();
  const worker = await app.restartWorker();
  expect(worker.current).not.toBe(worker.previous);

  const retry = await request(app, listing);
  expect(retry.receivedAtMs).toBeGreaterThanOrEqual(throttle!.retryAtEpochSeconds * 1000 - 50);
  const ids = [7971, 7972, 7973, 7974, 7975];
  retry.raw([7970, ...ids].map(linkedinCard).join(""));
  let priorArrival = retry.receivedAtMs;
  const gaps: number[] = [];
  for (const [index, id] of ids.entries()) {
    const call = await request(app, detail(id));
    const gap = call.receivedAtMs - priorArrival;
    gaps.push(gap);
    expect(gap).toBeGreaterThanOrEqual([7000, 6000, 5000, 4000, 4000][index]! - 100);
    priorArrival = call.receivedAtMs;
    call.raw(`<div class="show-more-less-html__markup"><p>Review synthetic supplier contract ${id}.</p></div>`);
    await serveRoleTarget(roleTargetStream(app), "mismatch");
  }
  expect(Math.min(...gaps.slice(-2))).toBeLessThan(6800);
  expect((await completed(api, search.runId)).result).toMatchObject({ newJobs: 0, observedJobs: 1,
    postings: { received: 6, duplicate: 1, excluded: 5, pending: 0 } });
  expect(app.external.calls.filter((c) => c.path.startsWith(board))).toHaveLength(7);
  await info.attach("linkedin-arrival-gaps-ms", { contentType: "application/json", body: JSON.stringify(gaps) });
});

test("repeated LinkedIn throttles bound ordinary pacing across searches while the exact retry honors its deadline", async ({ api, app }, info) => {
  const scope = { queries: ["Synthetic engineer"], locations: ["Madrid"], boards: ["linkedin"], hoursOld: 0, newJobLimit: 1 };
  const search = await action(api, "discovery.search", scope);
  const arrivals: number[] = [];
  for (let count = 0; count < 4; count++) {
    const attempt = await request(app, listing);
    arrivals.push(attempt.receivedAtMs);
    attempt.raw("Busy", { status: 429, ...(count ? { headers: { "Retry-After": "1" } } : {}) });
  }
  const retry = await request(app, listing);
  retry.raw(linkedinCard(7981));
  await completed(api, search.runId);
  const events = await throttleHistory(api, search.runId);
  expect(events.map((e) => e.retryAfterSeconds)).toEqual([null, 1, 1, 1]);
  expect(events[0]!.previousRunBoardRequest).toBeUndefined();
  expect(events[0]!.requestStartIntervalMs).toBeUndefined();
  for (const [index, event] of events.entries()) {
    expect(Math.abs(Date.parse(event.requestedAt) - arrivals[index]!)).toBeLessThan(1_000);
    if (index === 0) continue;
    const previous = events[index - 1]!;
    expect(event.previousRunBoardRequest).toEqual({ requestedAt: previous.requestedAt, phase: "listing", httpStatus: 429 });
    expect(event.requestStartIntervalMs).toBe(Date.parse(event.requestedAt) - Date.parse(previous.requestedAt));
    expect(Math.abs(event.requestStartIntervalMs! - (arrivals[index]! - arrivals[index - 1]!))).toBeLessThan(500);
  }
  const waits = events.map((e) => Math.round(e.retryAtEpochSeconds * 1000 - Date.parse(e.receivedAt)));
  expect(waits[0]).toBeGreaterThanOrEqual(4000);
  expect(waits[0]).toBeLessThan(8002);
  for (const wait of waits.slice(1)) expect(Math.abs(wait - 4000)).toBeLessThan(2);
  const fresh = await action(api, "discovery.search", { ...scope, queries: ["Another synthetic role"] });
  const ordinary = await request(app, listing);
  const gap = ordinary.receivedAtMs - retry.receivedAtMs;
  expect(gap).toBeGreaterThanOrEqual(14_900);
  expect(events.map((e) => e.ordinaryRequestIntervalSeconds)).toEqual([8, 12, 16, 16]);
  ordinary.raw(linkedinCard(7982));
  await completed(api, fresh.runId);
  const cancelled = await action(api, "discovery.search", { ...scope, queries: ["Cancelled synthetic search"] });
  await expect.poll(async () => {
    const { runs } = await json<{ runs: { runId: string }[] }>(api, "get", "/v1/discovery/runs");
    return runs.some((run) => run.runId === cancelled.runId) && (await app.discoveryCheckpoint(cancelled.runId)).units.length === 1;
  }).toBe(true);
  await json(api, "post", `/v1/action-runs/${cancelled.runId}/cancel`, {});
  expect((await terminal(api, cancelled.runId)).status).toBe("cancelled");
  const probe = await action(api, "discovery.search", { ...scope, queries: ["Final synthetic search"] });
  const next = await request(app, listing);
  expect(new URL(next.path, "http://localhost").searchParams.get("keywords")).toBe("Final synthetic search");
  expect(next.receivedAtMs - ordinary.receivedAtMs).toBeGreaterThanOrEqual(13_900);
  next.raw(linkedinCard(7983));
  await completed(api, probe.runId);
  await info.attach("linkedin-bounded-pacing", { contentType: "application/json", body: JSON.stringify({ waits, gap }) });
});
