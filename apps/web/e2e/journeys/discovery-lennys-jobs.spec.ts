import { action, completed, expect, json, terminal, test, type ExternalCall } from "../harness/fixtures.js";

test.use({ discoveryTransport: "jobstreaming", features: "profile,jobs,discovery" });

const boardPath = "/jobstreaming/lennysjobs";
const barcelona = "🇪🇸 Barcelona, Spain";
const remoteSpain = "🇪🇸 Spain (remote)";

function nativeParams(call: ExternalCall) {
  expect(call.method).toBe("POST");
  const batch = call.body;
  if (!Array.isArray(batch) || batch.length !== 1 || batch[0].indexName !== "job") {
    throw new Error("Expected a single native TrueUp job-index query");
  }
  const params = batch[0].params as {
    query: string; page: number; hitsPerPage: number; facetName?: string; facetQuery?: string; facetFilters?: string[][];
    trueupPartnerId: string; trueupRequestVersion: number; trueupCompanyPreferencesKey: string;
  };
  expect(params).toMatchObject({ trueupPartnerId: "lenny", trueupRequestVersion: 2, trueupCompanyPreferencesKey: "public", page: 0 });
  return params;
}

function listingResult(query: string, filterValues: string[][], hits: Record<string, unknown>[]) {
  const params = new URLSearchParams({ facetFilters: filterValues.flat().join(",") }).toString();
  return { results: [{ hits, query, page: 0, nbPages: 1, nbHits: hits.length, hitsPerPage: 15, params }, { hits: [], hitsPerPage: 0, nbHits: 999 }] };
}

test("Lenny’s Jobs resolves the saved location, uses role text or category IDs, and preserves existing postings", async ({ api, app }) => {
  const description = "Lead the synthetic engineering department.";
  const existing = await json<{ job_id: string }>(api, "post", "/v1/jobs/capture", {
    url: "https://www.lennysjobs.com/job/engineering", title: "Director of Engineering", company: "Example Engineering",
    location: "Barcelona, Spain", description,
  });
  const started = await action(api, "discovery.search", {
    boards: ["lennysjobs"], queries: ["Director of Engineering", "Software Engineering"], locations: ["Barcelona, Spain"], hoursOld: 0, newJobLimit: 10,
  });
  const hit = (key: string, title: string) => ({ job_id: key, title, company_name: "Example Engineering", location: "Barcelona, Spain" });
  const requests: { query: string; size: number }[] = [];
  for (let index = 0; index < 4; index += 1) {
    const call = await app.external.next({ match: (request) => request.path === boardPath });
    const params = nativeParams(call);
    const role = params.query === "Director of Engineering";
    if (!role) expect(params.query).toBe("");
    const category = role ? [] : [["job_category_ids_all:11"]];
    requests.push({ query: params.query, size: params.hitsPerPage });
    if (params.facetName) {
      expect(params).toMatchObject({ facetName: "job_locations_combined", facetQuery: "Barcelona", hitsPerPage: 0 });
      expect(params.facetFilters ?? []).toEqual(category);
      call.respond({ results: [{ facetHits: [{ value: "🇻🇪 Barcelona, Venezuela", count: 3 }, { value: barcelona, count: 2 }] }] });
    } else {
      const filters = [...category, ["job_locations_combined:" + barcelona]];
      expect(params.facetFilters).toEqual(filters);
      expect(params.hitsPerPage).toBe(15);
      call.respond(listingResult(params.query, filters, role ? [hit("engineering", "Director of Engineering")] : [hit("backend", "Backend Engineer")]));
    }
  }
  expect(requests).toEqual(expect.arrayContaining([
    { query: "Director of Engineering", size: 0 }, { query: "Director of Engineering", size: 15 },
    { query: "", size: 0 }, { query: "", size: 15 },
  ]));
  expect((await completed(api, started.runId)).result).toMatchObject({ failures: [], newJobs: 1, observedJobs: 2 });
  expect(await json(api, "get", `/v1/jobs/${existing.job_id}`)).toMatchObject({ description });
  const { jobs } = await json<{ jobs: { url: string }[] }>(api, "get", "/v1/jobs");
  expect(jobs.map((job) => job.url).sort()).toEqual(["https://www.lennysjobs.com/job/backend", "https://www.lennysjobs.com/job/engineering"]);
});

test("Lenny’s Jobs checks regional remote scope and filters stale listing updates", async ({ api, app }) => {
  const search = { boards: ["lennysjobs"], queries: ["Platform Engineer"], locations: [{ location: "Spain", remote: true }], hoursOld: 72, newJobLimit: 2 };
  const filters = [["job_locations_combined:" + remoteSpain]];
  for (const confirmed of [false, true]) {
    const run = await action(api, "discovery.search", search);
    const lookup = await app.external.next({ match: (request) => request.path === boardPath });
    expect(nativeParams(lookup)).toMatchObject({ facetName: "job_locations_combined", facetQuery: "Spain", hitsPerPage: 0 });
    lookup.respond({ results: [{ facetHits: [{ value: "🇪🇸 Spain", count: 4 }, { value: remoteSpain, count: 3 }] }] });
    const call = await app.external.next({ match: (request) => request.path === boardPath });
    expect(nativeParams(call)).toMatchObject({ query: "Platform Engineer", facetFilters: filters, hitsPerPage: 15 });
    const fields = { title: "Platform Engineer", company_name: "Example", location: "Spain (remote)" };
    const hits = [
      { ...fields, job_id: "fresh", updated_at: new Date().toISOString() },
      { ...fields, job_id: "old", updated_at: "2001-01-01T00:00:00Z" },
      { ...fields, job_id: "undated" },
    ];
    call.respond(listingResult("Platform Engineer", confirmed ? filters : [["job_locations_combined:🇪🇸 Spain"]], hits));
    if (confirmed) {
      expect((await completed(api, run.runId)).result).toMatchObject({ failures: [], newJobs: 1 });
      const { jobs } = await json<{ jobs: { url: string }[] }>(api, "get", "/v1/jobs");
      expect(jobs.map((job) => job.url)).toEqual(["https://www.lennysjobs.com/job/fresh"]);
    } else {
      expect((await terminal(api, run.runId)).status).toBe("failed");
      const { runs } = await json<{ runs: { runId: string; failures: unknown[] }[] }>(api, "get", "/v1/discovery/runs");
      expect(runs.find((item) => item.runId === run.runId)?.failures).toEqual([
        expect.objectContaining({ boards: ["lennysjobs"], message: expect.stringContaining("selected filters") }),
      ]);
      expect(await json(api, "get", "/v1/jobs")).toMatchObject({ jobs: [] });
    }
  }
});

test.describe("unconnected Lenny’s Jobs", () => {
  test.use({ discoveryTransport: "jobstreaming-lennys-missing" });

  test("identifies the missing listing connection before contacting any provider", async ({ api, app }) => {
    const started = await action(api, "discovery.search", {
      boards: ["lennysjobs"], queries: ["Engineering"], locations: ["Barcelona"], hoursOld: 0, newJobLimit: 1,
    });
    expect((await terminal(api, started.runId)).status).toBe("failed");
    const { runs } = await json<{ runs: { runId: string; failures: unknown[] }[] }>(api, "get", "/v1/discovery/runs");
    expect(runs.find((run) => run.runId === started.runId)?.failures).toEqual([
      expect.objectContaining({ boards: ["lennysjobs"], diagnostic: "missing_connection", message: expect.stringContaining("JOBSTREAMING_LENNYSJOBS_LISTINGS_URL") }),
    ]);
    expect(app.external.calls.filter((call) => call.path.startsWith("/jobstreaming/"))).toHaveLength(0);
  });
});
