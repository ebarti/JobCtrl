import type { APIRequestContext } from "@playwright/test";
import { action, completed, expect, json, terminal, test, type ExternalCall } from "../harness/fixtures.js";
import { createBaseline } from "./core-data.js";
import { linkedinCard } from "./linkedin-data.js";

const searchPath = "/jobstreaming/linkedin/jobs-guest/jobs/api/seeMoreJobPostings/search";
const url = (id: number) => `https://www.linkedin.com/jobs/view/${id}`;
const pageWithMore = (id: number) => linkedinCard(id) + '<div class="base-search-card"></div>'.repeat(9);
const scope = { queries: ["Synthetic navigation"], locations: ["Madrid"], boards: ["linkedin"], hoursOld: 0 };
const history = (api: APIRequestContext, run: string) => json<{ events: { payload: {
  phase: string; jobId?: string; receiptKey?: string; retryAtEpochSeconds: number; receivedAt: string; requestedAt: string;
} }[] }>(api, "get", `/v1/events?aggregateId=${run}&type=DiscoverySourceRateLimited`);

function captured429(call: ExternalCall, finalUrl: string, retryAfter: string | null) {
  const requestedAt = new Date(call.receivedAtMs).toISOString();
  const receivedAt = new Date().toISOString();
  call.respond({ finalUrl, statusCode: 429, html: "", navigation: { requestedAt, receivedAt, retryAfter } });
  return { requestedAt, receivedAt };
}

for (const retryAfter of ["11", null] as const) {
  test(`a search-owned LinkedIn posting 429 gates the next listing with ${retryAfter ? "Retry-After" : "the bounded fallback"}`, async ({ api, app }) => {
    await createBaseline(api);
    const { runId } = await action(api, "discovery.search", { ...scope, newJobLimit: 3 });
    const first = await app.external.next();
    expect(first.path).toContain(searchPath);
    first.raw(pageWithMore(7311));
    const pending = await app.external.next();
    const inFlightListing = pending.path.startsWith(searchPath) ? pending : null;
    const posting = inFlightListing ? await app.external.next() : pending;
    expect(posting.path).toBe("/posting-page");
    expect(posting.body["url"]).toBe(url(7311));
    const timing = captured429(posting, url(7311), retryAfter);
    await expect.poll(async () => (await history(api, runId)).events.length).toBe(1);
    const limited = (await history(api, runId)).events[0]!.payload;
    expect(Date.parse(limited.requestedAt)).toBe(Date.parse(timing.requestedAt));
    expect(Date.parse(limited.receivedAt)).toBe(Date.parse(timing.receivedAt));
    expect(limited).toMatchObject({ phase: "assessment", httpStatus: 429, board: "linkedin",
      responses: { listing: 1, detail: 0, other: 0, assessment: 1 }, retryAfterSeconds: retryAfter ? 11 : null,
      previousRunBoardRequest: { phase: "listing", httpStatus: 200 }, ordinaryRequestIntervalSeconds: 8,
      jobId: expect.any(String), receiptKey: expect.stringMatching(/^jobstreaming:/), postingRevision: 1 });
    expect(limited).not.toHaveProperty("unitId");
    expect(limited).not.toHaveProperty("leaseEpoch");
    expect(JSON.stringify(limited)).not.toContain("linkedin.com");
    const delay = limited.retryAtEpochSeconds - Date.parse(timing.receivedAt) / 1000;
    if (retryAfter) expect(delay).toBeCloseTo(11, 2);
    else { expect(delay).toBeGreaterThanOrEqual(4); expect(delay).toBeLessThanOrEqual(8.01); }
    if (inFlightListing) inFlightListing.raw(pageWithMore(7311));
    if (retryAfter) {
      const waits = async () => (await json<{ runs: { runId: string; cooldowns: unknown[] }[] }>(
        api, "get", "/v1/discovery/runs")).runs.find(run => run.runId === runId)?.cooldowns;
      await expect.poll(waits).toContainEqual(expect.objectContaining({ board: "linkedin", retryAtEpochSeconds: limited.retryAtEpochSeconds }));
      await app.restartWorker();
    }
    const later = await app.external.next({ timeout: 35_000 });
    expect(later.path).toContain(searchPath);
    expect(later.receivedAtMs).toBeGreaterThanOrEqual(limited.retryAtEpochSeconds * 1000 - 50);
    later.raw("Limited listing", { status: 429, headers: { "Retry-After": "1" } });
    const resumed = await app.external.next({ timeout: 35_000 });
    expect(resumed.path).toBe(later.path);
    resumed.raw(linkedinCard(7311));
    const result = (await completed(api, runId)).result as { newJobIds: string[] };
    expect(result).toMatchObject({ acquisitionStatus: "completed", newJobIds: [limited.jobId], failures: [],
      preparation: { failedJobs: 1, failures: [{ jobId: limited.jobId, stage: "enrich", code: "posting_fetch_blocked" }] } });
    const [sdk] = (await history(api, runId)).events;
    expect(sdk!.payload).toMatchObject({ phase: "listing", unitId: expect.any(String),
      previousRunBoardRequest: { phase: "assessment", httpStatus: 429 },
      responses: { listing: inFlightListing ? 3 : 2, detail: 0, other: 0, assessment: 1 } });
    const job = await json(api, "get", `/v1/jobs/${limited.jobId}`);
    expect(job).toMatchObject({ revision: 1, content_state: "listing_only" });
    expect(app.external.calls.filter(call => call.path === "/posting-page")).toHaveLength(1);
  });
}

test("a capture gateway 429, a different responding host and a manual refresh cannot throttle the search board", async ({ api, app }) => {
  await createBaseline(api);
  for (const [index, mode] of ["gateway", "redirect"].entries()) {
    const id = 7330 + index;
    const { runId } = await action(api, "discovery.search", { ...scope, newJobLimit: 1 });
    const listing = await app.external.next({ timeout: 20_000 });
    expect(listing.path).toContain(searchPath);
    listing.raw(linkedinCard(id));
    const posting = await app.external.next({ timeout: 20_000 });
    expect(posting.path).toBe("/posting-page");
    expect(posting.body["url"]).toBe(url(id));
    if (mode === "gateway") posting.raw("Capture service busy", { status: 429, headers: { "Retry-After": "120" } });
    else captured429(posting, "https://linkedin.com.example.org/jobs/redirected", "120");
    const result = (await completed(api, runId)).result as { newJobIds: string[] };
    expect(result).toMatchObject({ newJobs: 1, acquisitionStatus: "completed",
      preparation: { failures: [{ stage: "enrich", code: "posting_fetch_blocked" }] } });
    expect((await history(api, runId)).events).toHaveLength(0);
    if (mode === "gateway") {
      const manual = await action(api, "jobs.refresh", { job_id: result.newJobIds[0], expectedRevision: 1 });
      const read = await app.external.next();
      expect(read.path).toBe("/posting-page");
      captured429(read, url(id), "120");
      expect(await terminal(api, manual.runId)).toMatchObject({ status: "failed", errorCode: "posting_fetch_blocked" });
      expect((await history(api, runId)).events).toHaveLength(0);
    }
  }
});
