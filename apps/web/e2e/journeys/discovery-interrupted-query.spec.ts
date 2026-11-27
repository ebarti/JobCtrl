import type { APIRequestContext } from "@playwright/test";
import { action, completed, expect, json, test as appTest, type ApplicationStack } from "../harness/fixtures.js";
import { linkedinCard } from "./linkedin-data.js";
import { indeedPage } from "./indeed-data.js";

const listing = "/jobstreaming/linkedin/jobs-guest/jobs/api/seeMoreJobPostings/search";
const detail = "/jobstreaming/linkedin/jobs/view/8122";

// These acquisition journeys leave supervised assessments enabled. An admitted
// assessment that needs its posting page gets a real, terminal HTTP response.
const test = appTest.extend<{ unavailableAssessmentPages: void }>({
  unavailableAssessmentPages: [async ({ app }, use) => {
    const finished = use().then(() => null);
    while (true) {
      const page = await Promise.race([finished,
        app.external.next({ timeout: 95_000, match: (call) => call.path === "/posting-page" })]);
      if (!page) return;
      page.raw("This synthetic posting is unavailable.", { status: 404 });
    }
  }, { auto: true }],
});

async function nextLinkedIn(app: ApplicationStack) {
  const call = await app.external.next({ timeout: 35_000, match: (request) => request.path.startsWith("/jobstreaming/linkedin/") });
  return { call, url: new URL(call.path, "http://localhost") };
}

async function completedAcquisition(api: APIRequestContext, runId: string) {
  await completed(api, runId);
  const { runs } = await json<{ runs: { runId: string; status: string; failures: unknown[]; newJobs: number }[] }>(api, "get", "/v1/discovery/runs");
  const run = runs.find(row => row.runId === runId);
  expect(run).toMatchObject({ status: "completed", failures: [] });
  return run!;
}

test("the interrupted LinkedIn detail gets the next board request and yields one query after a repeated 429", async ({ api, app }) => {
  // This known title/company makes Discovery fetch the second card's detail before intake.
  await json(api, "post", "/v1/jobs/capture", { url: "https://example.com/jobs/previous-vacancy",
    title: "Synthetic Systems Engineer", company: "Synthetic Board Company", description: "Previously observed duties." });
  const queries = ["Track A", "Track B", "Track C"];
  const { runId } = await action(api, "discovery.search", { queries, locations: ["Madrid"], boards: ["linkedin"], newJobLimit: 6, hoursOld: 0 });
  const first = await nextLinkedIn(app);
  expect(first.url.pathname).toBe(listing);
  expect(first.url.searchParams.get("keywords")).toBe(queries[0]);
  first.call.raw(linkedinCard(8121).replace("Synthetic Systems Engineer", "First synthetic vacancy") + linkedinCard(8122));
  const blocked = await nextLinkedIn(app);
  expect(blocked.url.pathname).toBe(detail);
  blocked.call.raw("Too many requests", { status: 429, headers: { "Retry-After": "5" } });
  const events = (type: string) => json<{ events: { payload: { unitId: string; receiptKey: string; phase: string; httpStatus: number;
    retryAtEpochSeconds: number; requestedAt: string } }[] }>(api, "get", `/v1/events?aggregateId=${runId}&type=${type}`);
  await expect.poll(async () => (await events("DiscoverySourceRateLimited")).events.length).toBe(1);
  const before = await app.discoveryCheckpoint(runId);
  expect(before.receiptKeys.filter((row) => row.isNew)).toHaveLength(1);
  await app.restartWorker();

  const firstRetry = await nextLinkedIn(app);
  expect(firstRetry.url.pathname).toBe(detail);
  firstRetry.call.raw("Too many requests", { status: 429, headers: { "Retry-After": "5" } });
  const peer = await nextLinkedIn(app);
  expect(peer.url.pathname).toBe(listing);
  expect(queries.slice(1)).toContain(peer.url.searchParams.get("keywords"));
  peer.call.raw(linkedinCard(8123).replace("Synthetic Systems Engineer", "Peer synthetic vacancy"));

  const secondRetry = await nextLinkedIn(app);
  expect(secondRetry.url.pathname).toBe(detail);
  secondRetry.call.raw('<div class="show-more-less-html__markup"><p>Operate the recovery test catalog.</p></div>');
  const other = await nextLinkedIn(app);
  expect(other.url.pathname).toBe(listing);
  expect(new Set([peer.url.searchParams.get("keywords"), other.url.searchParams.get("keywords")])).toEqual(new Set(queries.slice(1)));
  other.call.raw(linkedinCard(8124).replace("Synthetic Systems Engineer", "Final synthetic vacancy"));

  await completedAcquisition(api, runId);
  const after = await app.discoveryCheckpoint(runId);
  expect(after.request.fingerprint).toBe(before.request.fingerprint);
  expect(after.received.map((item) => item.status)).not.toContain("pending");
  const limits = (await events("DiscoverySourceRateLimited")).events.reverse().map(event => event.payload);
  const retries = (await events("DiscoverySourceRetryResponse")).events.reverse().map(event => event.payload);
  expect(limits).toHaveLength(2);
  expect(retries.map(response => response.httpStatus)).toEqual([429, 200]);
  for (const [index, retry] of retries.entries()) {
    const limit = limits[index]!;
    expect(limit.receiptKey).toMatch(/^jobstreaming:/);
    expect(retry).toMatchObject({ unitId: limit.unitId, receiptKey: limit.receiptKey, phase: "detail", retryAtEpochSeconds: limit.retryAtEpochSeconds });
    expect(Date.parse(retry.requestedAt)).toBeGreaterThanOrEqual(Math.trunc(limit.retryAtEpochSeconds * 1000));
  }
});

appTest("two interrupted LinkedIn listing queries both resume ahead of a fresh query", async ({ api, app }, info) => {
  const queries = ["Listing A", "Listing B", "Listing C"];
  const { runId } = await action(api, "discovery.search", { queries, locations: ["Madrid"], boards: ["linkedin"], newJobLimit: 6, hoursOld: 0 });
  const sequence = [queries[0], queries[0], queries[1], queries[0], queries[1], queries[2]];
  const pendingAssessments = new Set<string>();
  const arrivals: { kind: string; at: number }[] = [];
  let index = 0;
  while (index < sequence.length || pendingAssessments.size) {
    // A saved posting's assessment shares the next ordinary slot with a fresh listing.
    // Require progress on every real request, including when both assessments go first.
    const call = await app.external.next({ timeout: 25_000 });
    if (index >= 5) {
      const minimum = index === 5 ? 14_000 : 13_000;
      expect(call.receivedAtMs - arrivals.at(-1)!.at).toBeGreaterThanOrEqual(minimum - 100);
    }
    if (call.path === "/posting-page") {
      expect(index).toBeGreaterThanOrEqual(5);
      const url = String(call.body["url"]);
      expect(pendingAssessments.delete(url), `unexpected assessment ${url}`).toBe(true);
      arrivals.push({ kind: new URL(url).pathname, at: call.receivedAtMs });
      call.raw("This synthetic posting is unavailable.", { status: 404 });
      continue;
    }
    const url = new URL(call.path, "http://localhost");
    expect(url.pathname).toBe(listing);
    expect(index).toBeLessThan(sequence.length);
    expect(url.searchParams.get("keywords")).toBe(sequence[index]);
    arrivals.push({ kind: sequence[index]!, at: call.receivedAtMs });
    if (index < 3) call.raw("Too many requests", { status: 429, headers: { "Retry-After": "1" } });
    else {
      const id = 8220 + index;
      pendingAssessments.add(`https://www.linkedin.com/jobs/view/${id}`);
      call.raw(linkedinCard(id).replace("Synthetic Systems Engineer", `Synthetic vacancy ${index}`));
    }
    index++;
  }
  await info.attach("linkedin-shared-request-order", { contentType: "application/json", body: JSON.stringify(arrivals) });
  expect((await completedAcquisition(api, runId)).newJobs).toBe(3);
  const retries = await json<{ events: { payload: { phase: string; httpStatus: number; unitId: string } }[] }>(api, "get",
    `/v1/events?aggregateId=${runId}&type=DiscoverySourceRetryResponse`);
  const responses = retries.events.reverse().map(event => event.payload);
  expect(responses.map(response => [response.phase, response.httpStatus])).toEqual([["listing", 429], ["listing", 200], ["listing", 200]]);
  expect(responses[0]!.unitId).toBe(responses[1]!.unitId);
  expect(responses[2]!.unitId).not.toBe(responses[0]!.unitId);
});

test("an interrupted LinkedIn detail can use the last slot when fresh-query allocation favors a sibling", async ({ api, app }) => {
  await json(api, "post", "/v1/jobs/capture", { url: "https://example.com/jobs/old-listing",
    title: "Synthetic Systems Engineer", company: "Synthetic Board Company", description: "Prior unrelated work." });
  const queries = ["Budget A", "Budget B", "Budget C"];
  const { runId } = await action(api, "discovery.search", { queries, locations: ["Madrid"],
    boards: ["linkedin", "indeed"], newJobLimit: 2, hoursOld: 0 });
  const first = await nextLinkedIn(app);
  expect(first.url.searchParams.get("keywords")).toBe(queries[0]);
  first.call.raw(linkedinCard(8311) + linkedinCard(8312).replace("Synthetic Systems Engineer", "Surplus listing"));
  const blocked = await nextLinkedIn(app);
  expect(blocked.url.pathname).toBe("/jobstreaming/linkedin/jobs/view/8311");
  blocked.call.raw("Too many requests", { status: 429, headers: { "Retry-After": "8" } });
  const firstPeer = await app.external.next({ match: call => call.path === "/jobstreaming/indeed" });
  expect(firstPeer.body["query"]).toContain('what: "Budget A"');
  const { events } = await json<{ events: { payload: { retryAtEpochSeconds: number } }[] }>(api, "get",
    `/v1/events?aggregateId=${runId}&type=DiscoverySourceRateLimited`);
  await expect.poll(() => Date.now(), { timeout: 12_000 }).toBeGreaterThanOrEqual(events[0]!.payload.retryAtEpochSeconds * 1000);
  firstPeer.respond(indeedPage({ jobs: [{ job_key: "budget-1", title: "Indeed budget vacancy", company: "Fixture", description: "One new job.", location: "Madrid" }],
    cursor: null, complete: true }));
  const retry = await nextLinkedIn(app);
  expect(retry.url.pathname).toBe(blocked.url.pathname);
  const before = await app.discoveryCheckpoint(runId);
  expect(before.receiptKeys.filter(row => row.isNew)).toHaveLength(1);
  retry.call.raw('<div class="show-more-less-html__markup"><p>Accept a distinct recovered position.</p></div>');

  expect((await completedAcquisition(api, runId)).newJobs).toBe(2);
  const final = await app.discoveryCheckpoint(runId);
  expect(final.receiptKeys.filter(row => row.isNew)).toHaveLength(2);
  expect(final.received.filter(row => row.status === "beyond_limit")).toHaveLength(1);
  expect(app.external.calls.filter(call => call.path.startsWith("/jobstreaming/linkedin/"))).toHaveLength(3);
});
