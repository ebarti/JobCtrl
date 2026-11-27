import { action, completed, expect, json, test } from "../harness/fixtures.js";
import { indeedPage } from "./indeed-data.js";
import { linkedinCard } from "./linkedin-data.js";

const listingPath = "/jobstreaming/linkedin/jobs-guest/jobs/api/seeMoreJobPostings/search";
const detailPath = "/jobstreaming/linkedin/jobs/view/8411";

for (const phase of ["detail", "listing"] as const) {
  test(`a worker loss after LinkedIn retry headers replays the interrupted ${phase} before a fresh query`, async ({ api, app }) => {
    if (phase === "detail") {
      await json(api, "post", "/v1/jobs/capture", { url: "https://example.com/jobs/known-title",
        title: "Synthetic Systems Engineer", company: "Synthetic Board Company", description: "Previously captured duties." });
    }
    const { runId } = await action(api, "discovery.search", { queries: ["Crash A", "Crash B"], locations: ["Madrid"],
      boards: ["linkedin", "indeed"], newJobLimit: 2, hoursOld: 0 });
    const nextBoard = () => app.external.next({ match: call => call.path.startsWith("/jobstreaming/"), timeout: 35_000 });
    const first = await nextBoard();
    const firstUrl = new URL(first.path, "http://localhost");
    expect(firstUrl.pathname).toBe(listingPath);
    expect(firstUrl.searchParams.get("keywords")).toBe("Crash A");
    if (phase === "detail") first.raw(linkedinCard(8411));
    const limited = phase === "detail" ? await nextBoard() : first;
    expect(new URL(limited.path, "http://localhost").pathname).toBe(phase === "detail" ? detailPath : listingPath);
    limited.raw("Too many requests", { status: 429, headers: { "Retry-After": "8" } });
    const peer = await nextBoard();
    expect(peer.path).toBe("/jobstreaming/indeed");
    expect(peer.body["query"]).toContain('what: "Crash A"');
    const { events } = await json<{ events: { payload: { retryAtEpochSeconds: number } }[] }>(api, "get",
      `/v1/events?aggregateId=${runId}&type=DiscoverySourceRateLimited`);
    const deadline = events[0]!.payload.retryAtEpochSeconds;
    await expect.poll(() => Date.now(), { timeout: 13_000 }).toBeGreaterThanOrEqual(deadline * 1000);
    peer.respond(indeedPage({ jobs: [{ job_key: "first-crash-slot", title: "Synthetic peer vacancy", company: "Fixture",
      description: "Distinct peer duties.", location: "Madrid" }], complete: true, cursor: null }));

    const retry = await nextBoard();
    expect(retry.path).toBe(limited.path);
    retry.holdResponseBody();
    const retryEvents = () => json<{ events: { payload: { httpStatus: number; phase: string; unitId: string; retryAtEpochSeconds: number } }[] }>(
      api, "get", `/v1/events?aggregateId=${runId}&type=DiscoverySourceRetryResponse`);
    await expect.poll(async () => (await retryEvents()).events.map(event => event.payload.httpStatus)).toEqual([200]);
    const committed = () => json<{ events: { payload: { unitId: string; phase: string; receiptKey?: string; hasDescription?: boolean } }[] }>(
      api, "get", `/v1/events?aggregateId=${runId}&type=DiscoverySourceRetryProgressCommitted`);
    expect((await committed()).events).toHaveLength(0);
    const before = await app.discoveryCheckpoint(runId);
    expect(before.receiptKeys.filter(row => row.isNew)).toHaveLength(1);
    if (phase === "detail") expect(before.received.some(row => row.site === "linkedin" && row.status === "pending")).toBe(true);
    await app.restartWorker();

    const replay = await nextBoard();
    expect(replay.path).toBe(limited.path);
    replay.raw(phase === "detail" ? '<div class="show-more-less-html__markup"><p>Replayed distinct duties.</p></div>' : linkedinCard(8412));
    await completed(api, runId);
    const after = await app.discoveryCheckpoint(runId);
    expect(after.request.fingerprint).toBe(before.request.fingerprint);
    expect(after.receiptKeys.filter(row => row.isNew)).toHaveLength(2);
    expect(after.received.map(row => row.status)).not.toContain("pending");
    const responses = (await retryEvents()).events.map(event => event.payload);
    expect(responses).toHaveLength(2);
    expect(new Set(responses.map(response => response.unitId)).size).toBe(1);
    for (const response of responses) expect(response).toMatchObject({ phase, retryAtEpochSeconds: deadline, httpStatus: 200 });
    expect((await committed()).events.map(event => event.payload)).toEqual([expect.objectContaining({
      phase, retryAtEpochSeconds: deadline, unitId: responses[0]!.unitId, progress: phase === "detail" ? "detail_saved" : "page_acknowledged",
      ...(phase === "detail" ? { receiptKey: expect.stringMatching(/^jobstreaming:/), hasDescription: true } : {}),
    })]);
  });
}

test("an interrupted detail can commit a peer query's saved description without another HTTP retry", async ({ api, app }) => {
  await json(api, "post", "/v1/jobs/capture", { url: "https://example.com/jobs/prior-peer",
    title: "Synthetic Systems Engineer", company: "Synthetic Board Company", description: "Previous duties." });
  const { runId } = await action(api, "discovery.search", { queries: ["Peer A", "Peer B"], locations: ["Madrid"],
    boards: ["linkedin"], newJobLimit: 4, hoursOld: 0 });
  const next = () => app.external.next({ match: call => call.path.startsWith("/jobstreaming/linkedin/"), timeout: 35_000 });
  const first = await next();
  expect(new URL(first.path, "http://localhost").searchParams.get("keywords")).toBe("Peer A");
  first.raw(linkedinCard(8411));
  for (let i = 0; i < 2; i++) {
    const detail = await next();
    expect(detail.path).toBe(detailPath);
    detail.raw("Too many requests", { status: 429, headers: { "Retry-After": "1" } });
  }
  const peer = await next();
  expect(new URL(peer.path, "http://localhost").searchParams.get("keywords")).toBe("Peer B");
  peer.raw(linkedinCard(8411));
  const peerDetail = await next();
  expect(peerDetail.path).toBe(detailPath);
  peerDetail.raw('<div class="show-more-less-html__markup"><p>Shared authoritative detail.</p></div>');
  await completed(api, runId);

  const events = (type: string) => json<{ events: { payload: { unitId: string; receiptKey: string; sourceReceiptKey?: string; httpStatus?: number } }[] }>(api, "get",
    `/v1/events?aggregateId=${runId}&type=${type}`);
  const limited = (await events("DiscoverySourceRateLimited")).events[0]!.payload;
  const responses = (await events("DiscoverySourceRetryResponse")).events.map(event => event.payload.httpStatus);
  expect(responses).toEqual([429]);
  const finished = (await events("DiscoverySourceRetryProgressCommitted")).events.map(event => event.payload);
  expect(finished).toEqual([expect.objectContaining({ progress: "detail_reused", hasDescription: true, unitId: limited.unitId,
    receiptKey: limited.receiptKey, sourceReceiptKey: expect.stringMatching(/^jobstreaming:/) })]);
  expect(finished[0]!.sourceReceiptKey).not.toEqual(limited.receiptKey);
  const checkpoint = await app.discoveryCheckpoint(runId);
  expect(checkpoint.receiptKeys).toHaveLength(2);
  expect(checkpoint.receiptKeys.filter(row => row.isNew)).toHaveLength(1);
  expect(app.external.calls.filter(call => call.path === detailPath)).toHaveLength(3);
});
