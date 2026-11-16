import { test, expect, json, action, terminal } from "../harness/fixtures.js";
import { observeSharedWorkerEventSource, sharedEventStreamTargets } from "../harness/shared-event-stream.js";
import { createScoredFit, type FitState } from "./fit-data.js";

type Source = {
  sourceId: string;
  revision: number;
  state: string;
  consecutiveFailures: number;
  [key: string]: unknown;
};
type Digest = {
  staleScores: { count: number };
  deepLinks: { staleScores: string };
  blockedSources: {
    count: number;
    sources: { sourceId: string; consecutiveFailures: number }[];
  };
};

test("Jobs attention opens and reloads the counted stale Fit cohort without starting work", async ({ api, app, page }, testInfo) => {
  const { posting, fit } = await createScoredFit(api, app, "attention-fit-navigation");
  const control = await json<{ job_id: string; title: string }>(api, "post", "/v1/jobs/capture", {
    url: "https://example.com/jobs/attention-unassessed-control",
    title: "Synthetic Unassessed Attention Control",
    company: "Synthetic Attention Company",
    description: "Implement and maintain durable workflow recovery.",
  });
  const revised = await json<{ job_id: string; title: string }>(api, "patch", `/v1/jobs/${posting.job_id}`, {
    expectedRevision: posting.revision,
    description: "Implement and maintain durable workflow recovery. Document the current revision.",
  });
  const digest = await json<Digest>(api, "get", "/v1/digest");
  expect(digest.staleScores.count).toBe(1);
  const staleFit = await json<FitState>(api, "get", `/v1/jobs/${posting.job_id}/fit`);
  expect(staleFit.current).toBe(false);
  expect(staleFit.score).toEqual(fit.score);
  const callsBeforeNavigation = app.external.calls.length;
  const browserWrites: { method: string; path: string }[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/v1/") && !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      browserWrites.push({ method: request.method(), path: url.pathname });
    }
  });
  await page.goto("/jobs?grid=v1&job_state=active&fit_state=all&sort=discovered_at&direction=desc&offset=0&limit=50");
  const table = page.getByRole("table", { name: "Jobs table", exact: true });
  await expect(table.getByRole("link", { name: revised.title, exact: true })).toBeVisible();
  await expect(table.getByRole("link", { name: control.title, exact: true })).toBeVisible();
  const notice = page.getByRole("link", { name: "1 fit assessment to update", exact: true });
  await expect(notice).toHaveAttribute("href", digest.deepLinks.staleScores);

  async function verifyDestination(navigate: () => Promise<unknown>) {
    // Observe the real request on both click and reload, including the broken
    // legacy request so a field mismatch fails directly instead of timing out.
    const queried = page.waitForResponse((response) => response.request().method() === "GET"
      && new URL(response.url()).pathname === "/v1/jobs/query"
      && new URL(response.url()).searchParams.get("sort") === "fit_score");
    await navigate();
    const response = await queried;
    expect(response.status()).toBe(200);
    const query = new URL(response.url()).searchParams;
    expect(query.get("job_state")).toBe("active");
    expect(query.get("fit_state")).toBe("stale");
    expect(query.has("state")).toBe(false);
    const columnFilters = JSON.parse(query.get("column_filters") ?? "{}") as Record<string, unknown>;
    expect(columnFilters).not.toHaveProperty("current_state");
    const destination = await response.json() as {
      total: number;
      rows: { job: { job_id: string }; fit: { current: boolean }; scalars: { current_state: string | null } }[];
    };
    expect(destination.total).toBe(digest.staleScores.count);
    expect(destination.rows.map((row) => row.job.job_id)).toEqual([posting.job_id]);
    expect(destination.rows[0]!.fit.current).toBe(false);
    // Factual Fit staleness must work independently of workflow state.
    expect(destination.rows[0]!.scalars.current_state).not.toBe("stale");
    const url = new URL(page.url());
    expect(url.searchParams.get("grid")).toBe("v1");
    expect(url.searchParams.get("fit_state")).toBe("stale");
    await expect(table.locator("tbody tr")).toHaveCount(digest.staleScores.count);
    await expect(table.getByRole("link", { name: revised.title, exact: true })).toBeVisible();
    await expect(table.getByRole("link", { name: control.title, exact: true })).toHaveCount(0);
  }

  await verifyDestination(() => notice.click());
  await verifyDestination(() => page.reload());
  expect((await json<Digest>(api, "get", "/v1/digest")).staleScores.count).toBe(digest.staleScores.count);
  expect((await json<FitState>(api, "get", `/v1/jobs/${posting.job_id}/fit`)).score).toEqual(staleFit.score);
  expect(browserWrites).toEqual([]);
  expect(app.external.calls).toHaveLength(callsBeforeNavigation);
  await testInfo.attach("jobs-attention-stale-fit-destination", { contentType: "image/png", body: await page.screenshot({ animations: "disabled" }) });
});

test("Jobs attention follows committed visibility and reviewed deletion events without reloading", async ({ api, app, page, browser }, testInfo) => {
  const { posting } = await createScoredFit(api, app, "attention-lifecycle");
  const revised = await json<{ job_id: string; title: string; revision: number; state_revision: number }>(api, "patch", `/v1/jobs/${posting.job_id}`, {
    expectedRevision: posting.revision,
    description: "Implement and maintain durable workflow recovery. Document the current revision.",
  });
  expect((await json<Digest>(api, "get", "/v1/digest")).staleScores.count).toBe(1);
  const observedEvents: { type: string; aggregateId: string; payload: { action?: string } }[] = [];
  const browserDigests: Digest[] = [];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const observeFrame = (data: string) => {
    const event = JSON.parse(data) as typeof observedEvents[number];
    if (event.type === "JobUpdated" && event.aggregateId === posting.job_id) observedEvents.push(event);
  };
  cdp.on("Network.eventSourceMessageReceived", (frame) => observeFrame(frame.data));
  let stopWorkerObserver: (() => Promise<void>) | undefined;
  try {
    page.on("response", async (response) => {
      if (response.request().method() === "GET" && new URL(response.url()).pathname === "/v1/digest" && response.ok()) {
        // Cancelled superseded reads may lose their browser response body; only
        // completed actual responses count as refresh evidence below.
        try { browserDigests.push(await response.json() as Digest); } catch { /* No completed response to record. */ }
      }
    });
    await page.goto("/jobs");
    if (await page.evaluate(() => typeof SharedWorker !== "undefined")) {
      await expect.poll(async () => (await sharedEventStreamTargets(browser, app.baseURL)).length,
        { message: "the committed stream has one real shared worker target" }).toBe(1);
      const target = (await sharedEventStreamTargets(browser, app.baseURL))[0]!;
      stopWorkerObserver = await observeSharedWorkerEventSource(browser, target.targetId, observeFrame);
    }
    const table = page.getByRole("table", { name: "Jobs table", exact: true });
    const staleNotice = page.getByRole("link", { name: "1 fit assessment to update", exact: true });
    await expect(staleNotice).toBeVisible();
    await expect(table.getByRole("link", { name: revised.title, exact: true })).toBeVisible();
    const documentTimeOrigin = await page.evaluate(() => performance.timeOrigin);

    async function verifyTransition(actionName: string, expected: number, mutate: () => Promise<unknown>) {
      const readsBefore = browserDigests.length;
      const eventsBefore = observedEvents.length;
      await mutate();
      expect((await json<Digest>(api, "get", "/v1/digest")).staleScores.count).toBe(expected);
      await expect.poll(() => observedEvents.slice(eventsBefore).some((event) => event.payload.action === actionName), { message: `committed ${actionName} reaches the existing browser stream` }).toBe(true);
      await expect.poll(() => browserDigests.slice(readsBefore).some((digest) => digest.staleScores.count === expected), { message: `Digest refreshes after ${actionName}` }).toBe(true);
      if (expected) await expect(staleNotice).toBeVisible();
      else await expect(staleNotice).toHaveCount(0);
    }

    await verifyTransition("hide", 0, () => json(api, "post", `/v1/jobs/${posting.job_id}/hide`, {}));
    await verifyTransition("unhide", 1, () => json(api, "post", `/v1/jobs/${posting.job_id}/unhide`, {}));
    await expect(table.getByRole("link", { name: revised.title, exact: true })).toBeVisible();
    await table.getByRole("checkbox", { name: `Select ${revised.title}`, exact: true }).check();
    await verifyTransition("delete", 0, () => page.getByRole("button", { name: "Delete", exact: true }).click());
    await expect(table.getByRole("link", { name: revised.title, exact: true })).toHaveCount(0);
    await verifyTransition("restore", 1, () => json(api, "post", `/v1/jobs/${posting.job_id}/restore`, {}));
    await verifyTransition("delete", 0, () => json(api, "post", `/v1/jobs/${posting.job_id}/delete`, {}));

    await page.getByRole("combobox", { name: "Filter a column", exact: true }).selectOption("job_state");
    const stateFilter = page.getByRole("dialog", { name: "Job state filter", exact: true });
    await stateFilter.getByRole("checkbox", { name: "Active", exact: true }).uncheck();
    await stateFilter.getByRole("checkbox", { name: "Deleted", exact: true }).check();
    await stateFilter.getByRole("button", { name: "Apply filters", exact: true }).click();
    await page.keyboard.press("Escape");
    await table.getByRole("checkbox", { name: `Select ${revised.title}`, exact: true }).check();
    await page.getByRole("button", { name: "Review permanent deletion", exact: true }).click();
    const review = page.getByRole("region", { name: "Review permanent deletion", exact: true });
    await expect(review).toContainText(revised.title);
    await review.getByLabel("Type DELETE to confirm", { exact: true }).fill("DELETE");
    await verifyTransition("permanent-delete", 0, () => review.getByRole("button", { name: "Permanently delete reviewed jobs", exact: true }).click());
    await expect(review).not.toBeVisible();
    await expect(table.getByRole("link", { name: revised.title, exact: true })).toHaveCount(0);
    expect((await json<{ total: number }>(api, "get", "/v1/jobs?status=all&include_hidden=true")).total).toBe(0);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentTimeOrigin);
    await testInfo.attach("jobs-attention-deletion-events", { contentType: "application/json", body: JSON.stringify({ observedEvents, staleCounts: browserDigests.map((digest) => digest.staleScores.count) }) });
    await testInfo.attach("jobs-attention-after-permanent-delete", { contentType: "image/png", body: await page.screenshot({ animations: "disabled" }) });
  } finally {
    await stopWorkerObserver?.();
    await cdp.detach();
  }
});

test("Jobs attention distinguishes deliberately inactive sources from quarantined or repeatedly failing sources without rewriting the registry", async ({
  api,
  app,
  page,
}, testInfo) => {
  const sources = () =>
    json<{ sources: Source[] }>(api, "get", "/v1/discovery/sources");
  const digest = () => json<Digest>(api, "get", "/v1/digest");
  const sourceId = "jobstreaming:linkedin";
  const original = (await sources()).sources;
  const prior = original.find((source) => source.sourceId === sourceId);
  await json(api, "post", "/v1/discovery/sources", {
    sourceId,
    displayName: "Synthetic controlled source",
    kind: "broad_board",
    state: "active",
    policyId: "broad_board_tolerated",
    adapterConfig: { board: "linkedin" },
    ...(prior ? { expectedRevision: prior.revision } : {}),
  });
  const settings = await json<{ revision: number }>(
    api,
    "get",
    "/v1/discovery/settings",
  );
  await json(api, "patch", "/v1/discovery/settings", {
    expectedRevision: settings.revision,
    queries: ["Synthetic source readiness engineer"],
    locations: [{ location: "Madrid", remote: false }],
    boards: ["linkedin"],
    resultsPerSite: 5,
    hoursOld: 0,
    newJobLimit: 5,
  });
  // Real worker runs retain real failed source receipts. No source health row is
  // inserted or replaced by the test harness.
  for (let failure = 1; failure <= 3; failure += 1) {
    const run = await action(api, "discovery.search", {});
    const provider = await app.external.next();
    expect(provider.path).toBe("/discovery");
    expect(provider.body["request"]).toMatchObject({
      query: "Synthetic source readiness engineer",
      sites: ["linkedin"],
    });
    provider.respond(
      { error: "controlled_external_provider_unavailable" },
      503,
    );
    expect((await terminal(api, run.runId))["status"]).toBe("failed");
    const source = (await sources()).sources.find(
      (item) => item.sourceId === sourceId,
    )!;
    expect(source.consecutiveFailures).toBe(failure);
    expect(
      (await digest()).blockedSources.sources.some(
        (item) => item.sourceId === sourceId,
      ),
    ).toBe(failure >= 3);
  }
  const failing = (await sources()).sources.find(
    (source) => source.sourceId === sourceId,
  )!;
  await json(
    api,
    "patch",
    `/v1/discovery/sources/${encodeURIComponent(sourceId)}/state`,
    {
      expectedRevision: failing.revision,
      state: "disabled",
      reason: "Synthetic explicit source deactivation.",
    },
  );
  const disabled = (await sources()).sources.find(
    (source) => source.sourceId === sourceId,
  )!;
  expect(disabled).toMatchObject({ state: "disabled", consecutiveFailures: 3 });
  expect((await digest()).blockedSources.count).toBe(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/jobs");
  await expect(
    page.getByRole("heading", { name: "Jobs", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Needs attention", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("sources normal", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText("healthy", { exact: true })).toHaveCount(0);
  expect(
    (await sources()).sources.find((source) => source.sourceId === sourceId),
  ).toEqual(disabled);

  await json(api, "post", "/v1/discovery/sources", {
    sourceId: "qa:quarantined",
    displayName: "Synthetic quarantined source",
    kind: "ats_api",
    state: "quarantined",
  });
  const snapshot = (await sources()).sources;
  const blocked = await digest();
  expect(blocked.blockedSources).toEqual({
    count: 1,
    sources: [
      expect.objectContaining({
        sourceId: "qa:quarantined",
        consecutiveFailures: 0,
      }),
    ],
  });
  await page.reload();
  const attention = page.getByRole("region", {
    name: "Needs attention",
    exact: true,
  });
  await expect(
    attention.getByRole("link", {
      name: "1 search source needs attention",
      exact: true,
    }),
  ).toHaveAttribute("href", "/discovery");
  await testInfo.attach("jobs-attention-quarantine-not-inactive", {
    contentType: "image/png",
    body: await page.screenshot(),
  });
  expect((await sources()).sources).toEqual(snapshot);
  await digest();
  expect((await sources()).sources).toEqual(snapshot);
  expect(app.external.calls.filter((call) => call.path === "/model")).toEqual(
    [],
  );
});
