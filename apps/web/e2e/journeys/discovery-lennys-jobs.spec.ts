import { action, completed, expect, json, terminal, test } from "../harness/fixtures.js";

test.use({ discoveryTransport: "jobstreaming", features: "profile,jobs,discovery" });

test("Lenny’s Jobs sends each saved search and admits matching cards from a generic listing page", async ({ api, app }) => {
  const queries = ["Director of Engineering", "Product Manager"];
  const description = "Lead the synthetic engineering department.";
  const existing = await json<{ job_id: string }>(api, "post", "/v1/jobs/capture", {
    url: "https://www.lennysjobs.com/job/engineering", title: queries[0], company: "Example Engineering",
    location: "Barcelona, Catalonia, Spain", description,
  });
  const started = await action(api, "discovery.search", {
    boards: ["lennysjobs"], queries, locations: ["Barcelona, Spain"], hoursOld: 0, newJobLimit: 10,
  });
  const hits = [
    { job_id: "engineering", title: queries[0], company_name: "Example Engineering", location: "Barcelona, Catalonia, Spain" },
    { job_id: "product", title: queries[1], company_name: "Example Product", location: "Barcelona, Spain" },
    { job_id: "other-title", title: "Retail Manager", company_name: "Example Store", location: "Barcelona, Spain" },
    { job_id: "other-place", title: queries[0], company_name: "Example Abroad", location: "Barcelona, Venezuela; Madrid, Spain" },
  ];
  const receivedQueries: (string | null)[] = [];
  while (receivedQueries.length < queries.length) {
    const call = await app.external.next({ match: (request) => request.path.startsWith("/jobstreaming/lennysjobs?") });
    const params = new URL(call.path, "http://localhost").searchParams;
    receivedQueries.push(params.get("query"));
    expect(params.get("location")).toBe("Barcelona, Spain");
    expect(params.get("page")).toBe("0");
    const data = { props: { pageProps: { initialJobs: { hits, query: "", page: 0, nbPages: 1, nbHits: hits.length } } } };
    call.raw('<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify(data) + "</script>", { headers: { "Content-Type": "text/html" } });
  }
  expect(receivedQueries.sort()).toEqual([...queries].sort());
  expect((await completed(api, started.runId)).result).toMatchObject({ failures: [], newJobs: 1, observedJobs: 2 });
  expect(await json(api, "get", `/v1/jobs/${existing.job_id}`)).toMatchObject({ description });
  const { jobs } = await json<{ jobs: { url: string }[] }>(api, "get", "/v1/jobs");
  expect(jobs.map((job) => job.url).sort()).toEqual(["https://www.lennysjobs.com/job/engineering", "https://www.lennysjobs.com/job/product"]);
});

test("Lenny’s Jobs enforces posting age and remote scope on the listing connection", async ({ api, app }) => {
  const search = { boards: ["lennysjobs"], queries: ["Platform Engineer"], locations: [{ location: "Spain", remote: true }], hoursOld: 72, newJobLimit: 2 };
  const hits = [{ job_id: "platform", title: "Platform Engineer", company_name: "Example", location: "Remote" }];
  for (const confirmed of [false, true]) {
    const run = await action(api, "discovery.search", search);
    const call = await app.external.next({ match: (request) => request.path.startsWith("/jobstreaming/lennysjobs?") });
    const params = new URL(call.path, "http://localhost").searchParams;
    expect(Object.fromEntries(params)).toMatchObject({ query: "Platform Engineer", location: "Spain", is_remote: "true", hours_old: "72" });
    call.respond({ hits, query: "Platform Engineer", page: 0, nbPages: 1, params: confirmed ? params.toString() : "is_remote=true" });
    if (confirmed) {
      expect((await completed(api, run.runId)).result).toMatchObject({ failures: [], newJobs: 1 });
    } else {
      expect((await terminal(api, run.runId)).status).toBe("failed");
      const { runs } = await json<{ runs: { runId: string; failures: unknown[] }[] }>(api, "get", "/v1/discovery/runs");
      expect(runs.find((item) => item.runId === run.runId)?.failures).toEqual([
        expect.objectContaining({ boards: ["lennysjobs"], message: expect.stringContaining("posting age") }),
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
