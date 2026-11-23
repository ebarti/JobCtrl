import type { APIRequestContext } from "@playwright/test";
import { action, expect, json, terminal, test, type ApplicationStack } from "../harness/fixtures.js";

test.use({ discoveryTransport: "jobstreaming", features: "profile,jobs,discovery" });

const search = { queries: ["Synthetic service vacancy"], locations: ["Madrid"], hoursOld: 0, newJobLimit: 2 };
const publicCode = "discovery_provider_authentication_configuration";

type BoardFailure = { unitId: string; boards: string[]; code: string; diagnostic: string; message: string; httpStatus?: number };

async function failuresFor(api: APIRequestContext, app: ApplicationStack, runId: string, code = publicCode) {
  expect((await terminal(api, runId)).status).toBe("failed");
  const { runs } = await json<{ runs: { runId: string; failures: BoardFailure[] }[] }>(api, "get", "/v1/discovery/runs");
  const failures = runs.find((row) => row.runId === runId)!.failures;
  const { events } = await json<{ events: { payload: { sourceFailure?: BoardFailure } }[] }>(api, "get",
    `/v1/events?aggregateId=${runId}&type=DiscoveryRunUpdated&stage=board_search`);
  expect(events.map((event) => event.payload.sourceFailure)).toEqual(expect.arrayContaining(failures));
  expect(events).toHaveLength(failures.length);
  const saved = await app.discoveryCheckpoint(runId);
  for (const failure of failures) {
    expect(saved.units.find((unit) => unit.unitId === failure.unitId)).toMatchObject({ status: "failed", result: { failure } });
    expect(failure.code).toBe(code);
  }
  return failures;
}

test("board access diagnostics preserve a missing ZipRecruiter credential and a refused Indeed credential", async ({ api, app }) => {
  const started = await action(api, "discovery.search", { ...search, boards: ["zip_recruiter", "indeed"] });
  const call = await app.external.next();
  expect(call.path).toBe("/jobstreaming/indeed");
  call.respond({ reason: "Synthetic private access refusal" }, 401);
  const failures = await failuresFor(api, app, started.runId);
  expect(failures).toEqual([
    expect.objectContaining({ boards: ["zip_recruiter"], diagnostic: "missing_credential", message: expect.stringContaining("JOBSTREAMING_ZIPRECRUITER_AUTHORIZATION") }),
    expect.objectContaining({ boards: ["indeed"], diagnostic: "provider_access_denied", httpStatus: 401, message: expect.stringContaining("HTTP 401") }),
  ]);
  expect(app.external.calls.filter((outbound) => outbound.path.startsWith("/jobstreaming/"))).toHaveLength(1);

  const apiRefused = await action(api, "discovery.search", { ...search, boards: ["indeed"] });
  (await app.external.next()).respond({ errors: [{ message: "Unauthorized: synthetic private diagnostic marker" }] });
  const denied = await failuresFor(api, app, apiRefused.runId);
  expect(denied).toEqual([expect.objectContaining({ diagnostic: "provider_access_denied", message: expect.stringContaining("authentication or access error") })]);
  expect(JSON.stringify(denied)).not.toContain("private diagnostic marker");
});

test.describe("Indeed without a key", () => {
  test.use({ discoveryTransport: "jobstreaming-indeed-missing" });

  test("board access diagnostics preserve a missing Indeed key and a ZipRecruiter HTTP denial", async ({ api, app }) => {
    const started = await action(api, "discovery.search", { ...search, boards: ["indeed", "zip_recruiter"] });
    const call = await app.external.next();
    expect(call.path).toContain("/jobstreaming/ziprecruiter/jobs-app/jobs");
    call.respond({}, 403);
    expect(await failuresFor(api, app, started.runId)).toEqual([
      expect.objectContaining({ boards: ["indeed"], diagnostic: "missing_credential", message: expect.stringContaining("JOBSTREAMING_INDEED_API_KEY") }),
      expect.objectContaining({ boards: ["zip_recruiter"], diagnostic: "provider_access_denied", httpStatus: 403, message: expect.stringContaining("HTTP 403") }),
    ]);
    expect(app.external.calls.filter((outbound) => outbound.path.startsWith("/jobstreaming/"))).toHaveLength(1);
  });
});

test.describe("local TLS failure", () => {
  test.use({ discoveryTransport: "jobstreaming-tls-failure" });

  test("board access diagnostics distinguish a TLS failure from a board credential failure", async ({ api, app }) => {
    const started = await action(api, "discovery.search", { ...search, boards: ["indeed"] });
    expect(await failuresFor(api, app, started.runId)).toEqual([
      expect.objectContaining({ boards: ["indeed"], diagnostic: "tls_configuration", message: expect.stringContaining("TLS configuration") }),
    ]);
    expect(app.external.calls.filter((outbound) => outbound.path.startsWith("/jobstreaming/"))).toHaveLength(0);
  });
});

test.describe("historical board failures", () => {
  test.use({ sourceRevision: "17f9ce5be1de2f21735fb27d5dfe8f6d1b7c8118" });

  test("board rate limits explain historical partial searches and current LinkedIn detail failures", async ({ api, app, page }) => {
    const code = "discovery_provider_rate_limited";
    const message = "The board rate-limited this search. Wait before running another search on this board.";
    const legacyMessage = "The source could not complete its search; review its connection before retrying.";
    const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
    await json(api, "patch", "/v1/discovery/settings", {
      expectedRevision: settings.revision, boards: ["indeed", "linkedin"],
    });
    const legacy = await action(api, "discovery.search", { ...search, queries: ["Completed query", "Limited query"], boards: ["indeed"] });
    const empty = await app.external.next();
    expect(empty.path).toBe("/jobstreaming/indeed");
    expect(empty.body["query"]).toContain('what: "Completed query"');
    empty.respond({ data: { jobSearch: { pageInfo: { nextCursor: null }, results: [] } } });
    for (let attempt = 0; attempt < 3; attempt++) {
      const call = await app.external.next({ timeout: 20_000 });
      expect(call.path).toBe("/jobstreaming/indeed");
      expect(call.body["query"]).toContain('what: "Limited query"');
      call.respond({ errors: [{ message: "Too many requests" }] });
    }
    const receipt = await terminal(api, legacy.runId);
    expect(receipt).toMatchObject({ status: "succeeded", result: { status: "partial", failures: [{ code, message: legacyMessage }] } });

    await app.upgradeSource();
    const { runs } = await json<{ runs: { runId: string; failures: BoardFailure[] }[] }>(api, "get", "/v1/discovery/runs");
    expect(runs.find((run) => run.runId === legacy.runId)?.failures).toEqual([
      expect.objectContaining({ boards: ["indeed"], code, diagnostic: "rate_limited", message }),
    ]);
    expect((await terminal(api, legacy.runId)).result).toEqual(receipt.result);
    await page.goto("/jobs");
    const notice = page.getByRole("list", { name: "Search source failures" });
    await expect(notice).toContainText(`Indeed: ${message}`);

    // A known vacancy with a description requests targeted detail before intake.
    // LinkedIn's SDK raises its typed HTTP 429 directly on this path.
    await json(api, "post", "/v1/jobs/capture", { url: "https://example.com/jobs/known-rate-limit",
      title: "Synthetic service vacancy", company: "Synthetic board company", description: "Maintain the service directory." });
    const fresh = await action(api, "discovery.search", { ...search, boards: ["linkedin"] });
    const listing = await app.external.next();
    expect(listing.path).toContain("/jobstreaming/linkedin/jobs-guest/jobs/api/seeMoreJobPostings/search?");
    listing.raw('<div class="base-search-card"><a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/test-1234"><span class="sr-only">Synthetic service vacancy</span></a><h4 class="base-search-card__subtitle">Synthetic board company</h4></div>');
    const detail = await app.external.next();
    expect(detail.path).toBe("/jobstreaming/linkedin/jobs/view/1234");
    detail.raw("Private synthetic response", { status: 429 });
    expect(await failuresFor(api, app, fresh.runId, code)).toEqual([
      expect.objectContaining({ boards: ["linkedin"], code, diagnostic: "rate_limited", message }),
    ]);
    const { sources } = await json<{ sources: { sourceId: string; politeness: { rateLimitedCount: number } }[] }>(api, "get", "/v1/discovery/sources");
    expect(sources.find((source) => source.sourceId === "jobstreaming:linkedin")?.politeness.rateLimitedCount).toBe(1);
    await expect(notice).toContainText(`LinkedIn: ${message}`);
    await page.getByText("Search details", { exact: true }).click();
    await expect(page.getByRole("list", { name: "Recorded source failures" })).toContainText(`LinkedIn: ${message}`);
    expect(app.external.calls.filter((call) => call.path.startsWith("/jobstreaming/linkedin"))).toHaveLength(2);
  });
});
