import { DiscoverySettingsResponseSchema } from "@jobctrl/contracts";
import { test, expect, json, completed, terminal, action, type ApplicationStack } from "../harness/fixtures.js";
import { baseline, createBaseline } from "./core-data.js";
import { serveRoleTarget } from "./discovery-role-scope-data.js";
import type { APIRequestContext } from "@playwright/test";

// These are actual acquisition/recovery journeys. Full initial assessment is
// exercised by the ordinary saved-search journey with Preparation installed.
test.use({ discoveryTransport: "jobstreaming", features: "profile,jobs,discovery" });

type SearchResult = { status: string; newJobs: number; observedJobs: number; jobIds: string[]; failures: { boards: string[]; code: string; message: string; sourceFamily?: string; unitId?: string; sourceId?: string }[] };

async function settings(api: APIRequestContext, boards: string[], overrides: Record<string, unknown> = {}) {
  const before = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  return json(api, "patch", "/v1/discovery/settings", { expectedRevision: before.revision, boards, hoursOld: 73, newJobLimit: 5, resultsPerSite: 5, ...overrides });
}
async function preferences(api: APIRequestContext) {
  return createBaseline(api, { ...baseline, experience: { target_role: "Synthetic Reliability Engineer", target_locations: "Madrid", target_work_models: "remote" } });
}
function posting(key: string, datePublished: number | null) {
  return { job: { key, title: `Synthetic ${key} Engineer`, description: { html: "<p>Maintain durable services.</p>" },
    employer: { name: "Synthetic Hiring Company" }, location: { city: "Madrid", countryCode: "ES" },
    ...(datePublished === null ? {} : { datePublished }), attributes: [{ key: "DSQF7", label: "Remote" }] } };
}
function pageOf(results: ReturnType<typeof posting>[], nextCursor: string | null = null) {
  return { data: { jobSearch: { results, pageInfo: { nextCursor } } } };
}
async function indeedRequest(app: ApplicationStack, timeout?: number) {
  const call = await app.external.next(timeout ? { timeout } : undefined);
  expect(call.path).toBe("/jobstreaming/indeed");
  const query = String(call.body["query"]);
  expect(query).toContain('what: "Synthetic Reliability Engineer"');
  expect(query).toContain('where: "Madrid"');
  expect(query).toContain('keys: ["DSQF7"]');
  expect(query).not.toContain('field: "dateOnIndeed"');
  return call;
}
async function runResult(api: APIRequestContext, runId: string) {
  const done = await completed(api, runId);
  return done.result as SearchResult;
}

function expectAcknowledgedReceipts(checkpoint: Awaited<ReturnType<ApplicationStack["discoveryCheckpoint"]>>) {
  for (const adapter of checkpoint.adapters) {
    const unit = checkpoint.units.find((row) => row.unitId === adapter.unitId)!;
    expect(adapter.requestFingerprint).toBe(unit.sdkFingerprint);
    const receipts = checkpoint.receiptKeys.filter((row) => row.unitId === adapter.unitId && row.site === adapter.site);
    expect(new Set(adapter.acknowledgedKeys)).toEqual(new Set(receipts.map((row) => row.jobKey)));
    expect(adapter.emittedCount).toBe(receipts.length);
  }
}

for (const legacyCap of [1, 100]) {
  test(`native source pagination ignores legacy cap ${legacyCap}, commits exactly five new jobs after known and filtered listings, and acknowledges before stopping`, async ({ api, app }, testInfo) => {
    await preferences(api);
    await settings(api, ["indeed"], { resultsPerSite: legacyCap, newJobLimit: 1 });
    const saved = await json<{ effectiveSettings: { resultsPerSite: unknown }; effective: { resultsPerSite: unknown } }>(api, "get", "/v1/discovery/settings");
    expect(DiscoverySettingsResponseSchema.safeParse(saved).success).toBe(true);
    expect(saved.effectiveSettings.resultsPerSite).toEqual({ value: legacyCap, source: "persisted", activation: "inactive", editable: false, locked: true });
    expect(saved.effective.resultsPerSite).toEqual(saved.effectiveSettings.resultsPerSite);
    if (legacyCap === 1) {
      const help = await app.cli(["discover", "--help"]);
      expect(help.exitCode, help.stderr).toBe(0);
      expect(help.stdout).not.toContain("--results-per-site");
      const legacy = await app.cli(["discover", "--results-per-site", "1", "--help"]);
      expect(legacy.exitCode, legacy.stderr).toBe(0);
      expect(legacy.stdout).not.toContain("--results-per-site");
    }
    const body = { queries: ["Synthetic Reliability Engineer"], locations: [{ location: "Madrid", remote: true }] };
    const known = posting("PreviouslyKnown", Date.now());
    const seed = await action(api, "discovery.search", body);
    (await indeedRequest(app)).respond(pageOf([known]));
    expect(await runResult(api, seed.runId)).toMatchObject({ status: "completed", newJobs: 1 });

    await settings(api, ["indeed"], { resultsPerSite: legacyCap, newJobLimit: 5 });
    // The public action override is retained for compatibility but cannot
    // reactivate a provider-emission ceiling on a newly admitted search.
    const started = await action(api, "discovery.search", { ...body, resultsPerSite: legacyCap });
    const first = await indeedRequest(app);
    expect(String(first.body["query"])).toContain("limit: 100");
    first.respond(pageOf([known, ...Array.from({ length: 99 }, (_, index) => posting(`Excluded${index}`, null))], "fresh-page"));
    const fresh = await indeedRequest(app);
    expect(String(fresh.body["query"])).toContain('cursor: "fresh-page"');
    expect(String(fresh.body["query"])).toContain("limit: 100");
    await expect.poll(async () => (await app.discoveryCheckpoint(started.runId)).receipts).toEqual({ accepted: 1, filtered: 99 });
    const before = await app.discoveryCheckpoint(started.runId);
    expect(before.request).toMatchObject({ sourceFetchPolicy: "source-native-v1", settings: { resultsPerSite: legacyCap } });
    expect(before.units).toEqual([expect.objectContaining({ resultsPerSite: null, sdkResultsWanted: null, sdkMaxPages: 50 })]);
    expectAcknowledgedReceipts(before);
    fresh.respond(pageOf([...Array.from({ length: 5 }, (_, index) => posting(`Fresh${index}`, Date.now())), posting("BeyondQuota", Date.now())], "held-after-quota"));
    // A prefetched request may be in flight. Completion must not need its
    // response or a sixth admission attempt to notice that capacity is full.
    const result = await runResult(api, started.runId);
    expect(result).toMatchObject({ status: "completed", newJobs: 5, observedJobs: 6, failures: [] });
    const checkpoint = await app.discoveryCheckpoint(started.runId);
    expect(checkpoint.receipts).toEqual({ accepted: 6, filtered: 99 });
    expect(checkpoint.receiptKeys.filter((row) => row.isNew)).toHaveLength(5);
    expect(checkpoint.units).toEqual([expect.objectContaining({ status: "budget_exhausted", result: { termination: "budget_exhaustion" } })]);
    expectAcknowledgedReceipts(checkpoint);
    expect(checkpoint.adapters[0]!.completed).toBe(false);
    expect(app.external.calls.filter((call) => call.path === "/model")).toHaveLength(0);
    await testInfo.attach("native-pagination-budget-receipts", { contentType: "application/json", body: JSON.stringify(checkpoint) });
  });
}

test("native source pagination distinguishes confirmed exhaustion from the SDK page safety limit", async ({ api, app }) => {
  await preferences(api);
  await settings(api, ["indeed"], { resultsPerSite: 1 });
  const body = { queries: ["Synthetic Reliability Engineer"], locations: [{ location: "Madrid", remote: true }] };
  const empty = await action(api, "discovery.search", body);
  (await indeedRequest(app)).respond(pageOf([]));
  expect(await runResult(api, empty.runId)).toMatchObject({ status: "completed", newJobs: 0 });
  expect((await app.discoveryCheckpoint(empty.runId)).units).toEqual([expect.objectContaining({ status: "completed", result: { termination: "source_exhausted", sourceTerminations: { indeed: "source_exhausted" } } })]);

  const bounded = await action(api, "discovery.search", body);
  for (let index = 0; index < 50; index++) {
    const call = await indeedRequest(app);
    expect(String(call.body["query"])).toContain("limit: 100");
    call.respond(pageOf([posting(`SafetyFiltered${index}`, null)], `safety-page-${index + 2}`));
  }
  expect((await terminal(api, bounded.runId)).status).toBe("failed");
  const checkpoint = await app.discoveryCheckpoint(bounded.runId);
  expect(checkpoint.receipts).toEqual({ filtered: 50 });
  expect(checkpoint.units).toEqual([expect.objectContaining({ status: "failed", sdkMaxPages: 50,
    result: expect.objectContaining({ termination: "page_limit", sourceTerminations: { indeed: "page_limit" }, failure: expect.objectContaining({ code: "discovery_provider_page_limit" }) }) })]);
  expectAcknowledgedReceipts(checkpoint);
  expect(app.external.calls.filter((call) => call.path === "/jobstreaming/indeed")).toHaveLength(51);
});

test.describe("frozen finite source-policy predecessor", () => {
  test.use({ sourceRevision: "6f46b0ba5913383b7c57ffcce986729fa0bdbf0e" });

  test("an actual predecessor search resumes its finite cap and fingerprint unchanged after upgrade", async ({ api, app }) => {
    await preferences(api);
    await settings(api, ["indeed"], { resultsPerSite: 3, newJobLimit: 5 });
    const started = await action(api, "discovery.search", { queries: ["Synthetic Reliability Engineer"], locations: [{ location: "Madrid", remote: true }] });
    (await indeedRequest(app)).respond(pageOf([posting("LegacyFirst", Date.now()), posting("LegacySecond", Date.now())], "legacy-page-two"));
    const held = await indeedRequest(app);
    expect(String(held.body["query"])).toContain('cursor: "legacy-page-two"');
    await expect.poll(async () => (await app.discoveryCheckpoint(started.runId)).adapters[0]).toMatchObject({ emittedCount: 2, state: { cursor: "legacy-page-two" } });
    const before = await app.discoveryCheckpoint(started.runId);
    expect(before.request.sourceFetchPolicy).toBeUndefined();
    expect(before.units).toEqual([expect.objectContaining({ resultsPerSite: 3, sdkResultsWanted: 3 })]);
    expectAcknowledgedReceipts(before);

    await app.upgradeSource();
    const resumed = await indeedRequest(app, 45_000);
    expect(String(resumed.body["query"])).toContain('cursor: "legacy-page-two"');
    resumed.respond(pageOf([posting("LegacyThird", Date.now()), posting("LegacyBeyondCap", Date.now())], "legacy-never-needed"));
    expect(await runResult(api, started.runId)).toMatchObject({ status: "completed", newJobs: 3, observedJobs: 3 });
    const after = await app.discoveryCheckpoint(started.runId);
    expect(after.request).toEqual(before.request);
    expect(after.adapters[0]!.requestFingerprint).toBe(before.adapters[0]!.requestFingerprint);
    expect(after.units[0]!.unitId).toBe(before.units[0]!.unitId);
    expect(after.units[0]!.sdkResultsWanted).toBe(3);
    expect(after.receipts).toEqual({ accepted: 3 });
    expectAcknowledgedReceipts(after);
  });
});

test("Remote posting-age search uses the pinned SDK, isolates auth and unsupported boards in either order, and preserves exact date evidence", async ({ api, app, page }, testInfo) => {
  await preferences(api);
  for (const boards of [["zip_recruiter", "glassdoor", "indeed"], ["indeed", "glassdoor", "zip_recruiter"]]) {
    await settings(api, boards);
    await page.goto("/jobs");
    const start = page.getByRole("button", { name: "Start search", exact: true });
    await expect(start).toBeEnabled();
    const acceptance = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/v1/actions/discovery.search");
    await start.click();
    const receipt = await acceptance;
    expect(receipt.status()).toBe(202);
    const { runId } = await receipt.json() as { runId: string };
    const provider = await indeedRequest(app);
    const progress = page.getByRole("region", { name: "Job search progress", exact: true });
    await expect(progress.getByRole("progressbar")).toBeVisible();
    const now = Date.now();
    provider.respond(pageOf([
      posting("Current", now), posting("Stale", now - 10 * 86400_000),
      posting("Unknown", null), posting("Boundary", now - 73 * 3600_000), posting("Future", now + 2 * 86400_000),
    ]));
    if (boards[0] === "zip_recruiter") await serveRoleTarget(app, "match");
    const result = await runResult(api, runId);
    expect(result.status).toBe("partial");
    expect(result.observedJobs).toBe(1);
    expect(result.newJobs).toBe(boards[0] === "indeed" ? 0 : 1);
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ boards: ["zip_recruiter"], code: "discovery_provider_authentication_configuration" }),
      expect.objectContaining({ boards: ["glassdoor"], code: "unsupported_remote_search" }),
    ]));
    expect(result.failures).toHaveLength(2);
    const history = await json<{ observations: { run_id: string; provenance: { postingAge: { accepted: boolean; requestedHours: number; reportedDate: string; referenceAt: string }; providerHoursOld: number | null } }[] }>(api, "get", `/v1/jobs/${result.jobIds[0]}/snapshots`);
    const observed = history.observations.find((row) => row.run_id === runId)!;
    expect(observed.provenance).toMatchObject({ provider: "jobstreaming", authority: "provider", providerHoursOld: null, postingAge: { accepted: true, requestedHours: 73, reportedDate: new Date(now).toISOString().slice(0, 10) } });
    expect(Number.isFinite(Date.parse(observed.provenance.postingAge.referenceAt))).toBe(true);
    await expect(progress).toContainText("Search completed · some sources unavailable");
    await expect(progress.getByRole("list", { name: "Search source failures" })).toContainText("ZipRecruiter");
    await expect(progress).toContainText("JOBSTREAMING_ZIPRECRUITER_AUTHORIZATION");
    await expect(progress).toContainText("Glassdoor cannot verify a location together with Remote");
    await expect(page.getByRole("link", { name: "Synthetic Current Engineer", exact: true })).toBeVisible();
    for (const name of ["Stale", "Unknown", "Boundary", "Future"]) await expect(page.getByRole("link", { name: `Synthetic ${name} Engineer`, exact: true })).toHaveCount(0);
    await expect(start).toBeEnabled();
    await page.reload();
    await expect(progress).toContainText("ZipRecruiter");
    const saved = await json<{ settings: { boards: string[]; hoursOld: number } }>(api, "get", "/v1/discovery/settings");
    expect(saved.settings).toMatchObject({ boards, hoursOld: 73 });
  }
  expect(app.external.calls.filter((call) => call.path !== "/catalog").map((call) => call.path)).toEqual(["/jobstreaming/indeed", "/model", "/jobstreaming/indeed"]);
  await testInfo.attach("remote-age-partial-source-results", { contentType: "image/png", body: await page.screenshot({ animations: "disabled" }) });

  const scopedBody = { queries: [{ query: "Synthetic Reliability Engineer", source_scope: ["broad_boards"] }], locations: [{ location: "Madrid", remote: true }] };
  await settings(api, ["zip_recruiter", "glassdoor"]);
  const failed = await action(api, "discovery.search", scopedBody);
  expect((await terminal(api, failed.runId)).status).toBe("failed");
  const runs = await json<{ runs: { runId: string; status: string; failures: unknown[] }[] }>(api, "get", "/v1/discovery/runs");
  expect(runs.runs.find((run) => run.runId === failed.runId)).toMatchObject({ status: "failed", failures: expect.any(Array) });

  // An empty successful source is distinct from every selected source failing.
  await settings(api, ["zip_recruiter", "indeed"]);
  const empty = await action(api, "discovery.search", scopedBody);
  (await indeedRequest(app)).respond(pageOf([]));
  expect(await runResult(api, empty.runId)).toMatchObject({ status: "partial", newJobs: 0, observedJobs: 0 });

  // Repeated per-query receipts remain canonical, while the normal Jobs strip
  // exposes each exact actionable board failure only once.
  await settings(api, ["zip_recruiter", "glassdoor", "indeed"]);
  const queries = ["Synthetic Reliability Engineer", "Synthetic Platform Engineer"];
  const locations = [{ location: "Madrid", remote: true }, { location: "Barcelona", remote: true }];
  const priorCalls = app.external.calls.length;
  const multi = await action(api, "discovery.search", { queries: queries.map((query) => ({ query, source_scope: ["broad_boards"] })), locations });
  const combinations = queries.flatMap((query) => locations.map(({ location }) => ({ query, location })));
  for (const [index, { query, location }] of combinations.entries()) {
    const provider = await app.external.next();
    expect(provider.path).toBe("/jobstreaming/indeed");
    expect(String(provider.body["query"])).toContain(`what: "${query}"`);
    expect(String(provider.body["query"])).toContain(`where: "${location}"`);
    provider.respond(pageOf([posting(`Compact${index}`, Date.now())]));
  }
  const multiResult = await runResult(api, multi.runId);
  expect(app.external.calls.slice(priorCalls).filter((call) => call.path === "/jobstreaming/indeed")).toHaveLength(combinations.length);
  expect(multiResult).toMatchObject({ status: "partial", newJobs: 4, observedJobs: 4 });
  expect(multiResult.failures).toHaveLength(8);
  expect(new Set(multiResult.failures.map((failure) => failure.unitId)).size).toBe(8);
  for (const board of ["zip_recruiter", "glassdoor"]) {
    const failures = multiResult.failures.filter((failure) => failure.boards.includes(board));
    expect(failures).toHaveLength(4);
    expect(new Set(failures.map((failure) => JSON.stringify([failure.sourceFamily, failure.boards, failure.code, failure.message]))).size).toBe(1);
  }
  await page.goto("/jobs");
  const progress = page.getByRole("region", { name: "Job search progress", exact: true });
  await expect(progress).toContainText("Search completed · some sources unavailable");
  await expect(progress).toContainText("4 new jobs");
  await expect(progress).toContainText("4 observed");
  const notices = progress.getByRole("list", { name: "Search source failures", exact: true }).getByRole("listitem");
  await expect(notices).toHaveCount(2);
  await expect(notices.filter({ hasText: "ZipRecruiter" })).toContainText("4 query/location combinations affected");
  await expect(notices.filter({ hasText: "Glassdoor" })).toContainText("4 query/location combinations affected");
  for (const key of ["Compact0", "Compact1", "Compact2", "Compact3"]) await expect(page.getByRole("link", { name: `Synthetic ${key} Engineer`, exact: true })).toBeVisible();
  await progress.getByText("Search details", { exact: true }).click();
  const recorded = progress.getByRole("list", { name: "Recorded source failures", exact: true }).getByRole("listitem");
  await expect(recorded).toHaveCount(8);
  for (const failure of multiResult.failures) {
    expect(failure.unitId).toBeTruthy();
    const receipt = recorded.filter({ hasText: failure.unitId! });
    await expect(receipt).toContainText(failure.code);
    await expect(receipt).toContainText(`Boards: ${failure.boards.join(", ")}`);
    await expect(receipt).toContainText(failure.message);
    await expect(receipt).toContainText(failure.sourceFamily!);
  }
  await progress.getByText("Search details", { exact: true }).click();
  await page.reload();
  await expect(notices).toHaveCount(2);
  const recordedRuns = await json<{ runs: { runId: string; failures: SearchResult["failures"] }[] }>(api, "get", "/v1/discovery/runs");
  expect(recordedRuns.runs.find((run) => run.runId === multi.runId)?.failures).toEqual(multiResult.failures);
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: 1440, height: 1000 });
  const table = page.getByRole("table", { name: "Jobs table", exact: true });
  await expect(table).toBeVisible();
  expect((await table.boundingBox())!.y).toBeLessThan(1000);
  await testInfo.attach("multi-query-source-failures-compact-desktop", { contentType: "image/png", body: await page.screenshot({ animations: "disabled" }) });
  await page.setViewportSize(viewport);

  // Current selection qualifies old remedies without rewriting the result.
  // Registry entries stay active when a board is simply deselected.
  await settings(api, ["indeed"]);
  await expect(notices).toHaveCount(0);
  await expect(progress.getByText("Recorded failures from sources no longer enabled are retained in Search details.", { exact: true })).toBeVisible();
  await expect(progress).toContainText("Last search result");
  await progress.getByRole("button", { name: "Dismiss last search result", exact: true }).click();
  await expect(progress.getByRole("button", { name: "Show last search result", exact: true })).toBeVisible();
  await expect(progress.getByRole("heading")).toHaveCount(0);
  await page.reload();
  await expect(progress.getByRole("button", { name: "Show last search result", exact: true })).toBeVisible();
  await expect(progress.getByRole("heading")).toHaveCount(0);
  await page.getByRole("link", { name: "Search preferences", exact: true }).click();
  await page.getByRole("link", { name: "Back to jobs", exact: true }).click();
  await expect(progress.getByRole("button", { name: "Show last search result", exact: true })).toBeVisible();
  await progress.getByText("Search details", { exact: true }).click();
  await expect(recorded).toHaveCount(8);
  await expect(recorded.first()).toContainText("Currently not selected or disabled");
  await expect(progress).toContainText("4 new jobs · 4 observed");
  await progress.getByText("Search details", { exact: true }).click();
  await progress.getByRole("button", { name: "Show last search result", exact: true }).click();
  await expect(progress.getByRole("heading")).toContainText("Search completed · some sources unavailable");
  await expect(notices).toHaveCount(0);
  await progress.getByRole("button", { name: "Dismiss last search result", exact: true }).click();
  await testInfo.attach("terminal-search-dismissed-desktop", { contentType: "image/png", body: await page.screenshot({ animations: "disabled" }) });
  expect((await json<{ runs: { runId: string; failures: SearchResult["failures"] }[] }>(api, "get", "/v1/discovery/runs")).runs.find((run) => run.runId === multi.runId)?.failures).toEqual(multiResult.failures);

  const following = await action(api, "discovery.search", scopedBody);
  const followingProvider = await indeedRequest(app);
  await expect(progress.getByRole("progressbar")).toBeVisible();
  await expect(progress.getByRole("button", { name: "Dismiss last search result", exact: true })).toHaveCount(0);
  await expect(progress.getByRole("button", { name: "Request stop", exact: true })).toBeVisible();
  followingProvider.respond(pageOf([]));
  expect(await runResult(api, following.runId)).toMatchObject({ status: "completed", newJobs: 0, observedJobs: 0 });
  await expect(progress.getByRole("heading")).toHaveText("Search completed");
  await expect(progress.getByRole("button", { name: "Dismiss last search result", exact: true })).toBeVisible();
});

test("pinned SDK Discovery retains its run and acknowledged cursor across worker restart, and cancellation preserves accepted jobs", async ({ api, app, page }, testInfo) => {
  await preferences(api);
  await settings(api, ["zip_recruiter", "indeed"]);
  const body = { queries: ["Synthetic Reliability Engineer"], locations: [{ location: "Madrid", remote: true }] };
  const started = await action(api, "discovery.search", body);
  const firstPage = [posting("BeforeRestart", Date.now()), posting("RestartStale", Date.now() - 10 * 86400_000), posting("RestartUnknown", null)];
  (await indeedRequest(app)).respond(pageOf(firstPage, "page-two"));
  const interrupted = await indeedRequest(app);
  expect(String(interrupted.body["query"])).toContain('cursor: "page-two"');
  // The SDK producer can request page two before the consumer commits page
  // one's receipts. Crash only after the real explicit-ack checkpoint exists.
  await expect.poll(async () => (await app.discoveryCheckpoint(started.runId)).adapters.find((adapter) => adapter.site === "indeed")).toMatchObject({ state: { cursor: "page-two" }, emittedCount: 3, completed: false });
  const checkpoint = await app.discoveryCheckpoint(started.runId);
  expect(checkpoint.receipts).toEqual({ accepted: 1, filtered: 2 });
  await testInfo.attach("sdk-precrash-committed-checkpoint", { contentType: "application/json", body: JSON.stringify(checkpoint) });
  const restarted = await app.restartWorker();
  expect(restarted.current).not.toBe(restarted.previous);
  // Recovery uses the production 30s heartbeat timeout plus bounded retry; the
  // existing 90s case deadline remains unchanged. Match terminal() observation.
  const resumed = await indeedRequest(app, 45_000);
  expect(String(resumed.body["query"])).toContain('cursor: "page-two"');
  resumed.respond(pageOf([...firstPage, posting("AfterRestart", Date.now())]));
  const result = await runResult(api, started.runId);
  expect(result).toMatchObject({ status: "partial", newJobs: 2, observedJobs: 2 });
  expect(new Set(result.jobIds).size).toBe(2);
  const observations = await Promise.all(result.jobIds.map((id) => json<{ observations: { run_id: string; provenance: { postingAge: { referenceAt: string } } }[] }>(api, "get", `/v1/jobs/${id}/snapshots`)));
  expect(observations.flatMap((history) => history.observations).map((row) => row.run_id)).toEqual([started.runId, started.runId]);
  expect(new Set(observations.flatMap((history) => history.observations).map((row) => row.provenance.postingAge.referenceAt)).size).toBe(1);

  const stopping = await action(api, "discovery.search", body);
  (await indeedRequest(app)).respond(pageOf([posting("BeforeStop", Date.now())], "stop-page"));
  const held = await indeedRequest(app);
  await page.goto("/jobs");
  const progress = page.getByRole("region", { name: "Job search progress", exact: true });
  await expect(progress).toContainText("1 new jobs");
  await progress.getByRole("button", { name: "Request stop", exact: true }).click();
  expect((await terminal(api, stopping.runId)).status).toBe("cancelled");
  held.respond(pageOf([posting("AfterStop", Date.now())]));
  await expect(progress).toContainText("Search cancelled");
  await expect(page.getByRole("link", { name: "Synthetic BeforeStop Engineer", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Synthetic AfterStop Engineer", exact: true })).toHaveCount(0);
  expect(app.external.calls.filter((call) => call.path === "/model")).toHaveLength(0);
});


test("pinned SDK quota completion preserves earlier source failures without awaiting another provider event", async ({ api, app, page }) => {
  await preferences(api);
  await settings(api, ["zip_recruiter", "indeed"], { newJobLimit: 1 });
  const started = await action(api, "discovery.search", { queries: ["Synthetic Reliability Engineer"], locations: [{ location: "Madrid", remote: true }] });
  (await indeedRequest(app)).respond(pageOf([posting("FillsBudget", Date.now())], "held-after-budget"));
  await expect.poll(async () => {
    const runs = await json<{ runs: { runId: string; newJobs: number }[] }>(api, "get", "/v1/discovery/runs");
    return runs.runs.find((run) => run.runId === started.runId)?.newJobs;
  }).toBe(1);
  const result = await runResult(api, started.runId);
  expect(result).toMatchObject({ status: "partial", newJobs: 1, observedJobs: 1, failures: [expect.objectContaining({ boards: ["zip_recruiter"], code: "discovery_provider_authentication_configuration" })] });
  const checkpoint = await app.discoveryCheckpoint(started.runId);
  expect(checkpoint.units).toContainEqual(expect.objectContaining({ status: "budget_exhausted", result: { termination: "budget_exhaustion" } }));
  expectAcknowledgedReceipts(checkpoint);
  await page.goto("/jobs");
  const progress = page.getByRole("region", { name: "Job search progress", exact: true });
  await expect(progress).toContainText("Search completed · some sources unavailable");
  await expect(progress).toContainText("ZipRecruiter");
  await expect(page.getByRole("link", { name: "Synthetic FillsBudget Engineer", exact: true })).toBeVisible();
});
