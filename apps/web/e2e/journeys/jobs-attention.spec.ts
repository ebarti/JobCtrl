import type { APIRequestContext } from "@playwright/test";
import { test, expect, json, action, terminal, modelCall } from "../harness/fixtures.js";
import { observeSharedWorkerEventSource, sharedEventStreamTargets } from "../harness/shared-event-stream.js";
import { createScoredFit, type FitState } from "./fit-data.js";
import { createBaseline, type Profile } from "./core-data.js";
import { authoredPartition, readCatalog, retainedCapability, type NormalizedSnapshot } from "./consolidation-data.js";
import { catalogContext, typedExtraction } from "./requirements-data.js";
import { qualificationBatchDecision } from "./qualification-data.js";
import { acceptReuseRequirements, captureReusePosting } from "./reuse-data.js";

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

async function reviseRecoveryEvidence(api: APIRequestContext, saved: Profile) {
  const profile = structuredClone(saved.profile);
  profile.resume.experience_entries[0]!.bullets[0] = "Documented operational handoffs for an existing recovery process.";
  return json<Profile>(api, "patch", "/v1/profile", { expectedProfileVersion: saved.profileVersion, profile });
}

test("Fit flags accepted demand and evidence changes without treating catalog revisions as Profile edits", async ({ api, app, page }) => {
  const { posting, fit, profile } = await createScoredFit(api, app, "attention-demand-currentness");
  const path = `/v1/jobs/${posting.job_id}`;
  const before = await json<NormalizedSnapshot>(api, "get", `${path}/requirements`);
  const original = before.requirements[0]!;
  const catalog = await readCatalog(api);

  async function verify(reasons: string[], requirementsCurrent: boolean) {
    const detail = await json<FitState>(api, "get", `${path}/fit`);
    expect(detail).toMatchObject({
      current: reasons.length === 0, requirements_current: requirementsCurrent, stale_reasons: reasons, score: fit.score,
      selection: { ready_for_materials: reasons.length === 0 && requirementsCurrent },
    });
    const grid = await json<{ rows: { job: { job_id: string }; fit: FitState }[] }>(api, "get", "/v1/jobs/query");
    expect(grid.rows.find((row) => row.job.job_id === posting.job_id)!.fit)
      .toMatchObject({ current: detail.current, stale_reasons: reasons });
    expect((await json<Digest>(api, "get", "/v1/digest")).staleScores.count).toBe(reasons.length ? 1 : 0);
  }

  const consolidating = api.post("/v1/requirements/consolidate", { data: { expected_catalog_revision: catalog.catalog_revision } });
  const catalogCall = await modelCall(app, "requirements.match_catalog");
  const { reuseRequirementId: _reuse, ...group } = retainedCapability(catalogCall, original.requirement_id, "recovery");
  catalogCall.reply(authoredPartition(catalogCall, [{ ...group, name: "Operational workflow recovery", definition: "Maintain durable recovery for operational workflows." }],
    [{ groupId: group.groupId, definition: original.normalized_demand.definition, jobIds: [posting.job_id] }]));
  const reconciled = await consolidating;
  expect(reconciled.status(), await reconciled.text()).toBe(200);
  const revised = await json<NormalizedSnapshot>(api, "get", `${path}/requirements`);
  expect(revised.revision).toBeGreaterThan(before.revision);
  expect(revised.requirements[0]!.canonical.name).toBe("Operational workflow recovery");
  expect(revised.requirements[0]!.normalized_demand.demand_fingerprint).toBe(original.normalized_demand.demand_fingerprint);
  await verify([], true);

  const irrelevant = structuredClone(profile.profile);
  irrelevant.personal.city = "Another City";
  const saved = await json<Profile>(api, "patch", "/v1/profile", { expectedProfileVersion: profile.profileVersion, profile: irrelevant });
  await verify([], true);
  const added = "Working proficiency in English is required.";
  const changed = await json<{ revision: number }>(api, "patch", path, {
    expectedRevision: posting.revision, description: posting.description + "\n" + added,
  });
  await verify([], false);
  await page.goto("/jobs");
  await expect(page.getByRole("link", { name: /fit assessment to update/ })).toHaveCount(0);

  const extracting = api.post(`${path}/requirements`, { data: { expected_posting_revision: changed.revision, expected_revision: revised.revision } });
  const extraction = await modelCall(app, "requirements.extract");
  extraction.reply(typedExtraction(extraction, {
    requirements: [{ localId: "recovery", text: posting.description }], languages: [{ text: added, language: "English", proficiency: "Working proficiency" }],
  }));
  const matching = await modelCall(app, "requirements.match_catalog");
  const retained = retainedCapability(matching, original.requirement_id, "recovery");
  retained.memberIds.push(...catalogContext(matching).incoming.map((row) => row.member_id));
  matching.reply(authoredPartition(matching, [retained],
    [{ groupId: retained.groupId, definition: original.normalized_demand.definition, jobIds: [posting.job_id] }]));
  const accepted = await extracting;
  expect(accepted.status(), await accepted.text()).toBe(200);
  await verify(["requirements_changed"], true);
  await expect(page.getByRole("link", { name: "1 fit assessment to update", exact: true })).toBeVisible();

  await reviseRecoveryEvidence(api, saved);
  await verify(["profile_facts_changed", "requirements_changed"], true);
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "fit.qualification-batch")).toHaveLength(1);
});

test("Fit keeps the saved score when consolidation only regroups the job's original demands", async ({ api, app, page }) => {
  const { library } = await createBaseline(api);
  const demands = [
    { localId: "workflow", text: "Implement durable workflow recovery." },
    { localId: "readiness", text: "Verify operational readiness for durable workflow recovery." },
  ];
  const posting = await captureReusePosting(api, "attention-regrouped-demands", demands.map((row) => row.text).join("\n"));
  const path = `/v1/jobs/${posting.job_id}`;
  const { snapshot } = await acceptReuseRequirements(api, app, posting, demands, {
    workflow: { verdict: "new" }, readiness: { verdict: "new" },
  });
  const assess = (expected_revision: number) => api.post(`${path}/fit/assess`, {
    data: { expected_revision, prepare_wording: false, prepare_coverage: false },
  });
  const first = assess(0);
  const initial = await modelCall(app, "fit.qualification-batch");
  const achievement = library.roles[0]!.achievements[0]!;
  initial.reply(qualificationBatchDecision(initial, () => ({
    achievementIds: [achievement.achievement_id],
    evidenceSourceIds: [`evidence:${achievement.source_refs[0]!.source_id}`],
  })));
  const admitted = await first;
  expect(admitted.status(), await admitted.text()).toBe(200);
  const fit = await admitted.json() as FitState;
  expect(fit.score.assessments).toHaveLength(2);
  expect(fit).toMatchObject({ qualifications_current: true, selection: { ready_for_materials: true } });
  const history = await json(api, "get", `${path}/fit/history`);
  const catalog = await readCatalog(api);
  const merge = api.post("/v1/requirements/consolidate", { data: { expected_catalog_revision: catalog.catalog_revision } });
  const call = await modelCall(app, "requirements.match_catalog");
  const ids = snapshot.requirements.map((row) => row.requirement_id).sort();
  const group = { ...retainedCapability(call, ids[0]!, "recovery"), memberIds: ids };
  call.reply(authoredPartition(call, [group], [{
    groupId: group.groupId, definition: "Implement durable workflow recovery and verify its operational readiness.",
    jobIds: [posting.job_id],
  }]));
  const merged = await merge;
  expect(merged.status(), await merged.text()).toBe(200);
  const current = await json<NormalizedSnapshot>(api, "get", `${path}/requirements`);
  expect(current.posting_hash).toBe(snapshot.posting_hash);
  expect(current.requirements.map((row) => row.spans)).toEqual(snapshot.requirements.map((row) => row.spans));
  expect(new Set(current.requirements.map((row) => row.requirement_id)).size).toBe(1);
  const callsBeforeRead = app.external.calls.length;
  expect(await json(api, "get", `${path}/fit`)).toMatchObject({
    current: true, requirements_current: true, qualifications_current: false, stale_reasons: [], score: fit.score,
    selection: { ready_for_materials: false },
  });
  expect(await json(api, "get", `${path}/fit/history`)).toEqual(history);
  expect((await json<Digest>(api, "get", "/v1/digest")).staleScores.count).toBe(0);
  await page.goto("/jobs");
  const table = page.getByRole("table", { name: "Jobs table", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.getByText(`${fit.score.score}/10`, { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /fit assessment to update/ })).toHaveCount(0);
  expect(app.external.calls).toHaveLength(callsBeforeRead);

  const second = assess(fit.score.revision);
  const combined = await modelCall(app, "fit.qualification-batch");
  expect((combined.body["context"] as { requirements: unknown[] }).requirements).toHaveLength(1);
  combined.reply(qualificationBatchDecision(combined, () => ({ kind: "missing" })));
  const qualified = await second;
  expect(qualified.status(), await qualified.text()).toBe(200);
  expect(await qualified.json()).toMatchObject({
    current: true, qualifications_current: true,
    score: { score: 1, assessments: [{ requirement_id: ids[0], kind: "missing" }] },
  });
});

test("Jobs attention opens and reloads the counted stale Fit cohort without starting work", async ({ api, app, page }, testInfo) => {
  const { posting: revised, fit, profile } = await createScoredFit(api, app, "attention-fit-navigation");
  const control = await json<{ job_id: string; title: string }>(api, "post", "/v1/jobs/capture", {
    url: "https://example.com/jobs/attention-unassessed-control",
    title: "Synthetic Unassessed Attention Control",
    company: "Synthetic Attention Company",
    description: "Implement and maintain durable workflow recovery.",
  });
  await reviseRecoveryEvidence(api, profile);
  const digest = await json<Digest>(api, "get", "/v1/digest");
  expect(digest.staleScores.count).toBe(1);
  const staleFit = await json<FitState>(api, "get", `/v1/jobs/${revised.job_id}/fit`);
  expect(staleFit).toMatchObject({ current: false, stale_reasons: ["profile_facts_changed"] });
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
    const queried = page.waitForRequest((request) => request.method() === "GET"
      && new URL(request.url()).pathname === "/v1/jobs/query"
      && new URL(request.url()).searchParams.get("sort") === "fit_score");
    await navigate();
    const request = new URL((await queried).url());
    const query = request.searchParams;
    expect(query.get("job_state")).toBe("active");
    expect(query.get("fit_state")).toBe("stale");
    expect(query.has("state")).toBe(false);
    const columnFilters = JSON.parse(query.get("column_filters") ?? "{}") as Record<string, unknown>;
    expect(columnFilters).not.toHaveProperty("current_state");
    const destination = await json<{
      total: number;
      rows: { job: { job_id: string }; fit: { current: boolean }; scalars: { current_state: string | null } }[];
    }>(api, "get", request.pathname + request.search);
    expect(destination.total).toBe(digest.staleScores.count);
    expect(destination.rows.map((row) => row.job.job_id)).toEqual([revised.job_id]);
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
  expect((await json<FitState>(api, "get", `/v1/jobs/${revised.job_id}/fit`)).score).toEqual(staleFit.score);
  expect(browserWrites).toEqual([]);
  expect(app.external.calls).toHaveLength(callsBeforeNavigation);
  await testInfo.attach("jobs-attention-stale-fit-destination", { contentType: "image/png", body: await page.screenshot({ animations: "disabled" }) });
});

test("Jobs attention follows committed visibility and reviewed deletion events without reloading", async ({ api, app, page, browser }, testInfo) => {
  const { posting, profile } = await createScoredFit(api, app, "attention-lifecycle");
  await reviseRecoveryEvidence(api, profile);
  const revised = await json<{ job_id: string; title: string; revision: number; state_revision: number }>(api, "get", `/v1/jobs/${posting.job_id}`);
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
  const sourceId = "jobstreaming:indeed";
  expect((await sources()).sources).toContainEqual(expect.objectContaining({ sourceId, state: "active" }));
  const settings = await json<{ revision: number }>(
    api,
    "get",
    "/v1/discovery/settings",
  );
  await json(api, "patch", "/v1/discovery/settings", {
    expectedRevision: settings.revision,
    queries: ["Synthetic source readiness engineer"],
    locations: [{ location: "Madrid", remote: false }],
    boards: ["indeed"],
    resultsPerSite: 5,
    hoursOld: 0,
    newJobLimit: 5,
  });
  // Real worker runs retain real failed source receipts. No source health row is
  // inserted or replaced by the test harness.
  for (let failure = 1; failure <= 3; failure += 1) {
    const run = await action(api, "discovery.search", {});
    const provider = await app.external.next();
    expect(provider.path).toBe("/jobstreaming/indeed");
    expect(String(provider.body["query"])).toContain('what: "Synthetic source readiness engineer"');
    provider.respond({ error: "access denied" }, 401);
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

  const otherBoard = (await sources()).sources.find((item) => item.sourceId === "jobstreaming:zip_recruiter")!;
  await json(api, "patch", `/v1/discovery/sources/${otherBoard.sourceId}/state`, {
    expectedRevision: otherBoard.revision, state: "quarantined",
  });
  const snapshot = (await sources()).sources;
  const blocked = await digest();
  expect(blocked.blockedSources).toEqual({
    count: 1,
    sources: [
      expect.objectContaining({
        sourceId: otherBoard.sourceId,
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
