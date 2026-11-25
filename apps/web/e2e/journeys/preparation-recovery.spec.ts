import type { APIResponse, Request, Response } from "@playwright/test";
import { indeedPage } from "./indeed-data.js";
import { createBaseline } from "./core-data.js";
import { posting, respondProducer } from "./preparation-cohort-data.js";
import { servePostingAssessment } from "./search-assessment-data.js";
import { action, terminal, test, expect, json, completed } from "../harness/fixtures.js";

const storageKey = (operation: "preparation.run" | "preparation.retry") =>
  `jobctrl:request-recovery:local:${encodeURIComponent(JSON.stringify(["local", operation, "preparation"]))}`;

test("a lost preparation admission is reconciled after reload without starting it twice", async ({
  app,
  api,
  page,
  allowRequestFailure,
  allowResponseError,
}) => {
  const workspace = await json<{ workspaceId: string; databaseInstanceId: string }>(
    api, "get", "/v1/health",
  );
  const settings = await json<{ revision: number }>(
    api,
    "get",
    "/v1/discovery/settings",
  );
  await json(api, "patch", "/v1/discovery/settings", {
    expectedRevision: settings.revision,
    queries: ["Synthetic recovery engineer"],
    locations: [{ location: "Madrid", remote: false }],
    boards: ["indeed"],
    resultsPerSite: 5,
    hoursOld: 0,
    newJobLimit: 5,
  });

  await page.goto("/pipelines");
  const controls = page.getByRole("region", { name: "Pipeline controls" });
  await expect(
    page.getByRole("heading", { name: "Start preparation" }),
  ).toBeVisible();
  await controls.getByLabel("Maximum jobs").fill("1");

  // Forward the actual browser request unchanged to Python. Only after its
  // real 202 is observed, sever delivery of that response to the browser.
  let admission: { status: number; body: { runId?: string } } | undefined;
  let releaseAdmission!: () => void;
  const admissionGate = new Promise<void>((resolve) => { releaseAdmission = resolve; });
  await page.route(
    "**/v1/actions/preparation.run",
    async (route) => {
      await admissionGate;
      const response = await route.fetch();
      admission = {
        status: response.status(),
        body: (await response.json()) as { runId?: string },
      };
      await route.abort("failed");
    },
    { times: 1 },
  );
  const isAdmission = (request: import("@playwright/test").Request) =>
    request.method() === "POST" &&
    new URL(request.url()).pathname === "/v1/actions/preparation.run";
  const sent = page.waitForRequest(isAdmission);
  const dropped = page.waitForEvent("requestfailed", {
    predicate: isAdmission,
  });
  const missingLookup = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET" &&
      url.origin === app.baseURL &&
      url.pathname === "/v1/action-runs/by-idempotency-key" &&
      url.search === "?action=preparation.run" &&
      response.status() === 404;
  });
  await controls.getByRole("button", { name: "Start work" }).click();
  const request = await sent;
  const requestId = request.headers()["idempotency-key"];
  try {
    expect(requestId).toBeTruthy();
    expect(request.headers()["expected-database-instance-id"]).toBe(workspace.databaseInstanceId);
    const notFound = await missingLookup;
    await allowResponseError(notFound, {
      method: "GET", status: 404, code: "not_found", action: "preparation.run",
      idempotencyKey: requestId!, databaseInstanceId: workspace.databaseInstanceId,
    });
    expect((await json<{ runs: unknown[] }>(api, "get", "/v1/action-runs?action=preparation.run")).runs).toEqual([]);
  } finally {
    releaseAdmission();
  }
  const failed = await dropped;
  expect(failed).toBe(request);
  expect(failed.failure()?.errorText).toContain("ERR_FAILED");
  allowRequestFailure(failed, "net::ERR_FAILED");
  expect(admission?.status).toBe(202);
  const runId = admission?.body.runId;
  expect(runId).toBeTruthy();
  expect(request.postDataJSON()).toMatchObject({
    recipe: "discover",
    scope: "pending",
    limit: 1,
  });

  // The held provider proves that the actual admitted worker is still active
  // while the browser reloads and checks its recorded request identity.
  const provider = await app.external.next();
  expect(provider.path).toBe("/jobstreaming/indeed");
  expect(String(provider.body["query"])).toContain('what: "Synthetic recovery engineer"');
  expect(String(provider.body["query"])).toContain('where: "Madrid"');
  const key = storageKey("preparation.run");
  const saved = await page.evaluate(
    (key) => sessionStorage.getItem(key),
    key,
  );
  expect(saved).toBeTruthy();
  const identity = JSON.parse(saved!) as Record<string, unknown>;
  expect(identity).toMatchObject({
    operation: "preparation.run",
    requestId,
    version: 1,
    workspaceId: workspace.workspaceId,
    databaseInstanceId: workspace.databaseInstanceId,
  });
  expect(identity["fingerprint"]).toMatch(/^[a-f0-9]{64}$/);
  expect(Object.keys(identity).sort()).toEqual(
    [
      "databaseInstanceId",
      "fingerprint",
      "operation",
      "requestId",
      "version",
      "workspaceId",
    ].sort(),
  );
  expect(saved).not.toContain("Synthetic recovery engineer");

  await page.reload();
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), key),
  ).toBe(saved);
  const notice = controls.getByRole("alert").filter({
    hasText: "The previous request is running.",
  });
  await notice.getByText("Request details", { exact: true }).click();
  await expect(notice).toContainText(`run ${runId}`);
  await expect(
    controls.getByRole("button", { name: "Retry the same request" }),
  ).toBeDisabled();
  const cohort = page.getByRole("region", { name: "Preparation cohort" });
  await expect(cohort.getByRole("combobox", { name: "Run" })).toContainText(
    runId!,
  );
  await expect(cohort.getByText(/^Recorded status: running/)).toBeVisible();
  await expect(
    cohort.getByText(/Recorded target job IDs: none recorded/),
  ).toBeVisible();
  await expect(
    cohort.getByText("Unavailable · 0 matching samples."),
  ).toBeVisible();
  await notice
    .getByRole("button", { name: "Check previous request" })
    .click();
  await expect(controls.getByRole("status")).toContainText(
    "The previous request is running. See preparation history for details.",
  );
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), key),
  ).toBeNull();
  await expect(
    controls.getByRole("button", { name: "Start work" }),
  ).toBeEnabled();

  provider.respond(indeedPage({ jobs: [], cursor: null, complete: true }));
  await completed(api, runId!);
  expect(
    app.external.calls.filter((call) => call.path === "/jobstreaming/indeed"),
  ).toHaveLength(1);
  const recorded = await json<{ runId: string; recipe: string }>(
    api,
    "get",
    `/v1/preparation/runs/${runId}`,
  );
  expect(recorded).toMatchObject({ runId, recipe: "discover" });
  const runs = await json<{ runs: { runId: string }[] }>(
    api, "get", "/v1/action-runs?action=preparation.run",
  );
  expect(runs.runs.map((row) => row.runId)).toEqual([runId]);
});

test("the job pane recovers a dropped selected-job retry without changing its sibling", async ({
  app, api, page, allowRequestFailure, allowResponseError,
}) => {
  const { library } = await createBaseline(api);
  const settings = await json<{ revision: number }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", { expectedRevision: settings.revision, dailyBudgetUsd: 10 });
  const workspace = await json<{ workspaceId: string; databaseInstanceId: string }>(api, "get", "/v1/health");
  const started = await action(api, "discovery.search", {
    queries: ["Synthetic retry engineer"], locations: [{ location: "Madrid", remote: true }], boards: ["indeed"], newJobLimit: 2,
  });
  const postings = [posting(451), posting(452)];
  const source = await app.external.next();
  expect(source.path).toBe("/jobstreaming/indeed");
  source.respond(indeedPage({ jobs: postings, cursor: null, complete: true }));
  const held = await Promise.all(postings.map(posted => app.external.next({
    match: call => call.path === "/posting-page" && call.body["url"] === posted.url,
  })));
  await json(api, "post", `/v1/action-runs/${started.runId}/cancel`, {});
  const cancelled = await terminal(api, started.runId);
  expect(cancelled).toMatchObject({ status: "cancelled" });
  await expect.poll(() => held.map(call => call.closed)).toEqual([true, true]);
  const before = await json<{ jobIds: string[]; status: string; executionPolicy: { version: string } }>(
    api, "get", `/v1/preparation/runs/${started.runId}`);
  expect(before).toMatchObject({ status: "cancelled", executionPolicy: { version: "search-jobs-v1" } });
  expect(before.jobIds).toHaveLength(2);
  const { jobs } = await json<{ jobs: { job_id: string; url: string }[] }>(api, "get", "/v1/jobs");
  const selected = jobs.find(job => job.url === postings[0]!.url)!.job_id;
  const sibling = jobs.find(job => job.url === postings[1]!.url)!.job_id;
  expect([selected, sibling].sort()).toEqual([...before.jobIds].sort());

  const operation = "preparation.retry";
  const admissionPath = `${app.baseURL}/v1/actions/${operation}`;
  const lookupPath = `${app.baseURL}/v1/action-runs/by-idempotency-key?action=${operation}`;
  const retryRuns = () => json<{ runs: { runId: string }[] }>(api, "get", `/v1/action-runs?action=${operation}`);
  const selectedBody = { run_id: started.runId, job_ids: [selected] };
  const isAdmission = (request: Request) => request.method() === "POST" && request.url() === admissionPath;
  await page.goto(`/jobs/${selected}?jobTab=fit`);
  const job = page.getByRole("main", { name: "Job details" });
  const retryButton = job.getByRole("button", { name: "Retry fit assessment for this job" });
  await expect(retryButton).toBeEnabled();
  await expect(job.getByText("Fit assessment cancelled.", { exact: true })).toBeVisible();

  const forwarded = new Map<Request, APIResponse>();
  const misses: Response[] = [];
  await page.route(lookupPath, async route => {
    const upstream = await route.fetch();
    if (upstream.status() === 404) forwarded.set(route.request(), upstream);
    try {
      await route.fulfill({ response: upstream });
    } finally {
      if (upstream.status() !== 404) await upstream.dispose();
    }
  });
  const recordMiss = (response: Response) => {
    if (response.url() === lookupPath && response.status() === 404) misses.push(response);
  };
  page.on("response", recordMiss);
  try {
    await page.route(admissionPath, route => route.abort("failed"), { times: 1 });
    const dropped = page.waitForEvent("requestfailed", isAdmission);
    await retryButton.click();
    const failed = await dropped;
    allowRequestFailure(failed, "net::ERR_FAILED");
    const requestId = failed.headers()["idempotency-key"]!;
    expect(requestId).toBeTruthy();
    expect(failed.headers()["expected-database-instance-id"]).toBe(workspace.databaseInstanceId);
    expect(failed.postDataJSON()).toEqual(selectedBody);
    const lookupHeaders = { "Idempotency-Key": requestId, "Expected-Database-Instance-Id": workspace.databaseInstanceId };
    expect((await api.get(lookupPath, { headers: lookupHeaders })).status()).toBe(404);
    expect((await retryRuns()).runs).toEqual([]);

    const key = storageKey(operation);
    const saved = await page.evaluate(key => sessionStorage.getItem(key), key);
    expect(saved).toBeTruthy();
    expect(JSON.parse(saved!)).toMatchObject({
      version: 1, operation, requestId, workspaceId: workspace.workspaceId, databaseInstanceId: workspace.databaseInstanceId,
    });
    await page.reload();
    const notice = job.getByRole("alert").filter({ hasText: "JobCtrl has no record of the previous request yet." });
    await expect(notice).toBeVisible();
    await expect(retryButton).toBeDisabled();

    const retryResponse = page.waitForResponse(response => isAdmission(response.request()));
    await notice.getByRole("button", { name: "Recover earlier retry", exact: true }).click();
    const admitted = await retryResponse;
    expect(admitted.status(), await admitted.text()).toBe(202);
    expect(admitted.request().headers()["idempotency-key"]).toBe(requestId);
    expect(admitted.request().headers()["expected-database-instance-id"]).toBe(workspace.databaseInstanceId);
    expect(admitted.request().postDataJSON()).toEqual(selectedBody);
    const retry = await admitted.json() as { runId: string };
    expect(await json(api, "get", `/v1/action-runs/${retry.runId}`)).toMatchObject({ runId: retry.runId, action: operation });
    const lookup = await api.get(lookupPath, { headers: lookupHeaders });
    expect(lookup.ok(), await lookup.text()).toBe(true);
    expect(await lookup.json()).toMatchObject({ runId: retry.runId });
    await servePostingAssessment(app, library, postings[0]!);
    await completed(api, retry.runId);

    const resumed = await json<{ jobIds: string[]; steps: { jobId: string; stage: string; status: string }[] }>(
      api, "get", `/v1/preparation/runs/${retry.runId}`);
    expect(resumed).toMatchObject({ parentRunId: started.runId, jobIds: [selected], status: "succeeded" });
    expect(resumed.steps.filter(step => step.stage === "fit" && step.status === "succeeded").map(step => step.jobId)).toEqual([selected]);
    expect(await json(api, "get", `/v1/jobs/${selected}/fit`)).toMatchObject({ current: true });
    expect(await json(api, "get", `/v1/jobs/${sibling}/fit`)).toMatchObject({ score: null });
    expect(await json(api, "get", `/v1/action-runs/${started.runId}`)).toEqual(cancelled);
    expect((await retryRuns()).runs.map(row => row.runId)).toEqual([retry.runId]);
    expect(app.external.calls.filter(call => call.path === "/jobstreaming/indeed")).toHaveLength(1);
    expect(app.external.calls.filter(call => call.path === "/posting-page").map(call => call.body["url"]).sort())
      .toEqual([postings[0]!.url, postings[0]!.url, postings[1]!.url].sort());
    expect(app.external.calls.filter(call => call.body["operation"] === "fit.qualification-batch")).toHaveLength(1);
    await expect(job.getByText("Fit assessment complete.", { exact: true })).toBeVisible();
    expect(await page.evaluate(key => sessionStorage.getItem(key), key)).toBeNull();
    expect(misses.length).toBeGreaterThan(0);
    await page.unrouteAll({ behavior: "wait" });
    for (const response of misses) {
      const upstream = forwarded.get(response.request());
      expect(upstream).toBeDefined();
      await allowResponseError(response, {
        method: "GET", status: 404, code: "not_found", action: operation, idempotencyKey: requestId, databaseInstanceId: workspace.databaseInstanceId,
      }, upstream);
    }
  } finally {
    page.off("response", recordMiss);
    await page.unrouteAll({ behavior: "wait" });
    await Promise.all([...forwarded.values()].map(response => response.dispose()));
  }
});

test.describe("imported shared-cohort retry scope", () => {
  test.use({ sqlitePredecessor: true });

  test("an imported shared cohort still refuses a narrowed retry", async ({ app, api }) => {
    await createBaseline(api);
    const settings = await json<{ revision: number }>(api, "get", "/v1/settings");
    await json(api, "patch", "/v1/settings", { expectedRevision: settings.revision, dailyBudgetUsd: 0 });
    const failed = posting(461);
    const spanish = { ...posting(462), description: "Mantener la recuperación de los flujos de trabajo.", unsupported: true };
    const payload = { queries: ["Synthetic retry engineer"], locations: ["Madrid"], boards: ["indeed"], newJobLimit: 2 };
    const predecessor = app.cli(["action", "discovery.search", "--data", JSON.stringify(payload)]);
    const source = await app.external.next();
    expect(source.path).toBe("/jobstreaming/indeed");
    const { unsupported: _fixtureOnly, ...spanishSource } = spanish;
    source.respond(indeedPage({ jobs: [failed, spanishSource], cursor: null, complete: true }));
    for (let index = 0; index < 7; index++) {
      const call = await app.external.next();
      if (call.path === "/posting-page" && call.body["url"] === failed.url) call.respond({}, 503);
      else respondProducer(call, [spanish]);
    }
    const previous = await predecessor;
    expect(previous.exitCode, previous.stderr).toBe(0);
    const { runId, status } = JSON.parse(previous.stdout) as { runId: string; status: string };
    expect(status).toBe("partial");
    const before = await json<{ jobIds: string[]; steps: unknown[]; executionPolicy: { version: string } }>(
      api, "get", `/v1/preparation/runs/${runId}`);
    expect(before.executionPolicy.version).toBe("search-cohort-v1");
    expect(before.jobIds).toHaveLength(2);
    const callsBeforeImport = app.external.calls.length;
    await app.upgradeSqliteToPostgres();
    expect(await json(api, "get", `/v1/preparation/runs/${runId}`)).toEqual(before);

    const retryRuns = () => json(api, "get", "/v1/action-runs?action=preparation.retry");
    const prior = await retryRuns();
    const retry = await api.post("/v1/actions/preparation.retry", { data: { run_id: runId, job_ids: [before.jobIds[0]] } });
    expect(retry.status(), await retry.text()).toBe(409);
    expect(await retry.json()).toMatchObject({ error: { code: "preparation_cohort_retry_scope_required" } });
    expect(await retryRuns()).toEqual(prior);
    expect(app.external.calls).toHaveLength(callsBeforeImport);
  });
});
