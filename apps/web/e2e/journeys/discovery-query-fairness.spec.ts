import { indeedPage } from "./indeed-data.js";
import { action, completed, expect, json, terminal, test, type ApplicationStack } from "../harness/fixtures.js";

test.use({ discoveryTransport: "jobstreaming", features: "profile,jobs,discovery" });

async function requestFor(app: ApplicationStack, query: string, timeout = 10_000) {
  const call = await app.external.next({ timeout });
  expect(call.path).toBe("/jobstreaming/indeed");
  expect(String(call.body["query"])).toContain(`what: "${query}"`);
  return call;
}

function searchPage(keys: string[]) {
  return { data: { jobSearch: { pageInfo: { nextCursor: null }, results: keys.map((key) => ({ job: {
    key, title: `Synthetic vacancy ${key}`, employer: { name: "Synthetic employer" },
    description: { html: "<p>Maintain test services.</p>" }, location: { city: "Madrid", countryCode: "ES" },
  } })) } } };
}

test("board queries share new-job slots across all nineteen queries in a 100-job search", async ({ api, app }) => {
  const queries = Array.from({ length: 19 }, (_, index) => `Synthetic Track ${index + 1}`);
  const started = await action(api, "discovery.search", {
    queries, locations: ["Madrid", "Barcelona", "Valencia"], boards: ["indeed"], newJobLimit: 100, hoursOld: 0,
  });
  for (const [index, query] of queries.entries()) {
    const call = await requestFor(app, query);
    expect(String(call.body["query"])).toContain('where: "Madrid"');
    // Every query has enough provider listings to take the entire budget.
    call.respond(searchPage(Array.from({ length: 100 }, (_, job) => `T${index}Vacancy${job}`)));
  }
  const result = (await completed(api, started.runId)).result as { newJobIds: string[] };
  expect(result).toMatchObject({ status: "completed", failures: [], newJobs: 100, observedJobs: 100 });
  expect(new Set(result.newJobIds).size).toBe(100);
  const after = await app.discoveryCheckpoint(started.runId);
  expect(after.receipts).toEqual({ accepted: 100 });
  const counts = after.adapters.map((adapter) => {
    const keys = after.receiptKeys.filter((row) => row.unitId === adapter.unitId && row.isNew).map((row) => row.jobKey);
    expect(new Set(adapter.acknowledgedKeys)).toEqual(new Set(keys));
    return keys.length;
  });
  expect(counts.sort((a, b) => a - b)).toEqual([...Array(14).fill(5), ...Array(5).fill(6)]);
  expect(app.external.calls.filter((call) => call.path === "/jobstreaming/indeed")).toHaveLength(19);
});

test("board queries share new-job slots and backfill an exhausted query after worker recovery", async ({ api, app }) => {
  const queries = ["Synthetic Track A", "Synthetic Track B", "Synthetic Track C"];
  const firstPage = searchPage(["A1", "A2", "A3", "A4", "A5", "A6", "A7"]);
  const started = await action(api, "discovery.search", {
    queries, locations: [{ location: "Madrid", remote: false }], boards: ["indeed"], newJobLimit: 6, hoursOld: 0,
  });

  (await requestFor(app, queries[0]!)).respond(firstPage);
  await requestFor(app, queries[1]!);
  const before = await app.discoveryCheckpoint(started.runId);
  expect(before.receiptKeys.filter((row) => row.isNew)).toHaveLength(2);
  const firstUnit = before.receiptKeys[0]!.unitId;
  const paused = before.adapters.find((row) => row.unitId === firstUnit)!;
  expect(paused.acknowledgedKeys).toHaveLength(2);

  await app.restartWorker();
  (await requestFor(app, queries[1]!, 45_000)).respond(searchPage(["A1", "B1"]));
  (await requestFor(app, queries[2]!)).respond(searchPage(["A1", "C1", "C2", "C3", "C4"]));
  (await requestFor(app, queries[0]!)).respond(firstPage);

  const result = (await completed(api, started.runId)).result as { newJobIds: string[] };
  expect(result).toMatchObject({ status: "completed", failures: [], newJobs: 6, observedJobs: 8 });
  expect(new Set(result.newJobIds).size).toBe(6);
  const after = await app.discoveryCheckpoint(started.runId);
  expect(after.request.fingerprint).toBe(before.request.fingerprint);
  expect(after.adapters).toHaveLength(3);
  for (const adapter of after.adapters) {
    const receipts = after.receiptKeys.filter((row) => row.unitId === adapter.unitId);
    expect(new Set(adapter.acknowledgedKeys)).toEqual(new Set(receipts.map((row) => row.jobKey)));
    const newCount = receipts.filter((row) => row.isNew).length;
    expect(newCount).toBe(adapter.unitId === firstUnit ? 3 : adapter.completed ? 1 : 2);
  }
  expect(after.adapters.find((row) => row.unitId === firstUnit)!.requestFingerprint).toBe(paused.requestFingerprint);
  expect(app.external.calls.filter((call) => call.path === "/jobstreaming/indeed")).toHaveLength(5);
});

test("board queries share new-job slots without retrying a rate-limited source for another query", async ({ api, app }) => {
  const queries = ["Synthetic Track A", "Synthetic Track B"];
  const started = await action(api, "discovery.search", {
    queries, locations: ["Madrid"], boards: ["indeed"], newJobLimit: 4, hoursOld: 0,
  });
  // The SDK has two bounded retries. A different query cannot bypass their
  // terminal rate-limit result by starting a fresh SDK invocation on this board.
  for (let attempt = 0; attempt < 3; attempt++) {
    (await requestFor(app, queries[0]!, 20_000)).respond({ errors: [{ message: "Too many requests" }] });
  }
  expect((await terminal(api, started.runId)).status).toBe("failed");
  const { runs } = await json<{ runs: { runId: string; failures: unknown[] }[] }>(api, "get", "/v1/discovery/runs");
  expect(runs.find((run) => run.runId === started.runId)!.failures).toEqual([
    expect.objectContaining({ boards: ["indeed"], code: "discovery_provider_rate_limited" }),
  ]);
  expect(app.external.calls.filter((call) => call.path === "/jobstreaming/indeed")).toHaveLength(3);
});

test("a LinkedIn rate limit skips the remaining locations while another board continues", async ({ api, app }) => {
  const query = "Synthetic reliability engineer";
  const started = await action(api, "discovery.search", {
    queries: [query], locations: ["Madrid", "Barcelona"], boards: ["linkedin", "indeed"], newJobLimit: 4, hoursOld: 0,
  });

  // Explicit permission to retry immediately lets the SDK exercise its configured
  // bounded retry policy before returning a terminal rate limit to JobCtrl.
  for (let attempt = 0; attempt < 3; attempt++) {
    const call = await app.external.next({ timeout: 20_000 });
    const url = new URL(call.path, "http://localhost");
    expect(url.pathname).toBe("/jobstreaming/linkedin/jobs-guest/jobs/api/seeMoreJobPostings/search");
    expect(url.searchParams.get("location")).toBe("Madrid");
    call.raw("Too many requests", { status: 429, headers: { "Retry-After": "0" } });
  }
  for (const location of ["Madrid", "Barcelona"]) {
    const call = await requestFor(app, query);
    expect(call.body["query"]).toContain(`where: "${location}"`);
    call.respond(searchPage([]));
  }

  expect((await completed(api, started.runId)).result).toMatchObject({
    status: "partial",
    failures: [{ boards: ["linkedin"], code: "discovery_provider_rate_limited" }],
  });
  expect(app.external.calls.filter((call) => call.path.startsWith("/jobstreaming/linkedin/"))).toHaveLength(3);
});

test.describe("paged JobStreaming listings", () => {

  test("board queries share new-job slots across location rows and resume the exact partial page", async ({ api, app }) => {
    const queries = ["Synthetic Track A", "Synthetic Track B"];
    const started = await action(api, "discovery.search", {
      queries, locations: ["Madrid", "Barcelona"], boards: ["indeed"], newJobLimit: 5, hoursOld: 0,
    });
    async function page(query: string, location: string, cursor: string | null, keys: string[], next: string | null = null) {
      const call = await app.external.next();
      expect(call.path).toBe("/jobstreaming/indeed");
      expect(String(call.body["query"])).toContain(`what: "${query}"`);
      expect(String(call.body["query"])).toContain(`where: "${location}"`);
      if (cursor) expect(String(call.body["query"])).toContain(cursor);
      call.respond(indeedPage({ jobs: keys.map((key) => ({ job_key: key, source_native_id: key, source_id: "synthetic-board",
        url: `https://www.indeed.com/viewjob?jk=${key}`, title: `Synthetic vacancy ${key}`, company: "Synthetic employer",
        description: "Maintain test services.", location })), cursor: next, complete: next === null }));
    }
    await page(queries[0]!, "Madrid", null, ["A1", "A2"], "second-page");
    await page(queries[0]!, "Madrid", "second-page", ["A3", "A4", "A5"]);
    await page(queries[1]!, "Madrid", null, ["A1", "B1"]);
    await page(queries[1]!, "Barcelona", null, []);
    await page(queries[0]!, "Barcelona", null, []);
    await page(queries[0]!, "Madrid", "second-page", ["A3", "A4", "A5"]);
    expect((await completed(api, started.runId)).result).toMatchObject({ status: "completed", failures: [], newJobs: 5, observedJobs: 6 });
    const after = await app.discoveryCheckpoint(started.runId);
    expect(after.receipts).toEqual({ accepted: 6 });
    expect(new Set(after.receiptKeys.filter((row) => row.isNew).map((row) => row.jobKey)).size).toBe(5);
    const { jobs } = await json<{ jobs: { url: string }[] }>(api, "get", "/v1/jobs");
    expect(jobs.map(({ url }) => new URL(url).searchParams.get("jk")).sort()).toEqual(["A1", "A2", "A3", "A4", "B1"]);
    expect(app.external.calls.filter((call) => call.path === "/jobstreaming/indeed")).toHaveLength(6);
  });
});
