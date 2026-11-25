import { createHash, randomUUID } from "node:crypto";
import type { Response } from "@playwright/test";
import { indeedPage } from "./indeed-data.js";
import { createBaseline } from "./core-data.js";
import { authoredPartition } from "./consolidation-data.js";
import { COMMON_DEMAND, posting, untilNormalization } from "./preparation-cohort-data.js";
import { catalogContext } from "./requirements-data.js";
import { serveQualification } from "./search-assessment-data.js";
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

test("the job pane recovers an earlier refused single-job retry and finishes the original search", async ({
  app, api, page, allowResponseError,
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
  const held = await app.external.next();
  expect(held.path).toBe("/posting-page");
  await json(api, "post", `/v1/action-runs/${started.runId}/cancel`, {});
  expect(await terminal(api, started.runId)).toMatchObject({ status: "cancelled" });
  await expect.poll(() => held.closed).toBe(true);
  const before = await json<{ jobIds: string[]; status: string }>(api, "get", `/v1/preparation/runs/${started.runId}`);
  expect(before.status).toBe("cancelled");
  expect(before.jobIds).toHaveLength(2);

  const operation = "preparation.retry";
  const admissionPath = `/v1/actions/${operation}`;
  const lookupPath = "/v1/action-runs/by-idempotency-key";
  const retryRunsPath = `/v1/action-runs?action=${operation}`;
  const requestId = randomUUID();
  const headers = { "Idempotency-Key": requestId, "Expected-Database-Instance-Id": workspace.databaseInstanceId };
  const oldBody = { run_id: started.runId, job_ids: [before.jobIds[0]!] };
  const refusal = await api.post(admissionPath, { data: oldBody, headers });
  expect(refusal.status()).toBe(409);
  expect(await refusal.json()).toMatchObject({ error: { code: "preparation_cohort_retry_scope_required" } });
  expect((await api.get(`${lookupPath}?action=${operation}`, { headers })).status()).toBe(404);
  expect(await json(api, "get", retryRunsPath)).toMatchObject({ runs: [] });

  await page.goto(`/jobs/${before.jobIds[0]}?jobTab=fit`);
  const job = page.getByRole("main", { name: "Job details" });
  const continueAssessment = job.getByRole("button", { name: "Continue fit assessment for all jobs" });
  await expect(continueAssessment).toBeEnabled();
  await expect(job.getByText("Fit assessment cancelled.", { exact: true })).toBeVisible();

  // Restore only the version-1 browser identity the old button left behind.
  // Its key, body fingerprint, workspace and refusal come from the real attempt above.
  const key = storageKey(operation);
  const record = { version: 1, operation, requestId,
    fingerprint: createHash("sha256").update(JSON.stringify({ action: operation, body: oldBody })).digest("hex"),
    workspaceId: workspace.workspaceId, databaseInstanceId: workspace.databaseInstanceId };
  await page.evaluate(({ key, record }) => sessionStorage.setItem(key, JSON.stringify(record)), { key, record });
  const misses: Response[] = [];
  page.on("response", response => {
    const url = new URL(response.url());
    if (response.status() === 404 && url.pathname === lookupPath && url.searchParams.get("action") === operation) misses.push(response);
  });
  await page.reload();
  const notice = job.getByRole("alert").filter({ hasText: "JobCtrl has no record of the previous request yet." });
  await expect(notice).toBeVisible();
  await expect(continueAssessment).toBeDisabled();
  await job.getByText("Preparation options and history", { exact: true }).click();
  await expect(job.getByRole("button", { name: "Retry unfinished", exact: true })).toBeDisabled();
  const beforeRecovery = app.external.calls.length;
  expect(await json(api, "get", retryRunsPath)).toMatchObject({ runs: [] });

  const isRetry = (response: Response) => response.request().method() === "POST" && new URL(response.url()).pathname === admissionPath;
  const oldPost = page.waitForResponse(isRetry);
  await notice.getByRole("button", { name: "Recover earlier retry" }).click();
  const rejected = await oldPost;
  await allowResponseError(rejected, { method: "POST", status: 409, code: "preparation_cohort_retry_scope_required" });
  expect(rejected.request().headers()["idempotency-key"]).toBe(requestId);
  expect(rejected.request().headers()["expected-database-instance-id"]).toBe(workspace.databaseInstanceId);
  expect(rejected.request().postDataJSON()).toEqual(oldBody);
  await expect(continueAssessment).toBeEnabled();
  await expect(notice).toHaveCount(0);
  await expect(job.getByRole("alert").filter({ hasText: "The earlier retry did not start." })).toBeVisible();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), key)).toBeNull();
  expect(await json(api, "get", retryRunsPath)).toMatchObject({ runs: [] });
  expect(app.external.calls).toHaveLength(beforeRecovery);

  const correctedPost = page.waitForResponse(isRetry);
  await continueAssessment.click();
  const admitted = await correctedPost;
  expect(admitted.status()).toBe(202);
  const correctedKey = admitted.request().headers()["idempotency-key"];
  expect(correctedKey).toBeTruthy();
  expect(correctedKey).not.toBe(requestId);
  expect(admitted.request().headers()["expected-database-instance-id"]).toBe(workspace.databaseInstanceId);
  expect(admitted.request().postDataJSON()).toEqual({ run_id: started.runId });
  const retry = (await admitted.json()) as { runId: string };
  const matching = await untilNormalization(app, postings);
  const input = catalogContext(matching);
  matching.reply(authoredPartition(matching, [{ groupId: "recovery", memberIds: input.incoming.map((row) => row.member_id),
    category: "professional_experience", name: COMMON_DEMAND, definition: COMMON_DEMAND }],
  [{ groupId: "recovery", definition: COMMON_DEMAND, jobIds: before.jobIds }]));
  await serveQualification(app, library);
  await completed(api, retry.runId);
  const resumed = await json<{ jobIds: string[]; steps: { jobId: string; stage: string; status: string }[] }>(api, "get", `/v1/preparation/runs/${retry.runId}`);
  expect(resumed).toMatchObject({ parentRunId: started.runId, jobIds: before.jobIds, status: "succeeded" });
  expect(resumed.steps.filter(step => step.stage === "fit" && step.status === "succeeded").map(step => step.jobId).sort()).toEqual([...before.jobIds].sort());
  for (const id of before.jobIds) expect(await json(api, "get", `/v1/jobs/${id}/fit`)).toMatchObject({ current: true });
  const recorded = await json<{ runs: { runId: string }[] }>(api, "get", retryRunsPath);
  expect(recorded.runs.map(row => row.runId)).toEqual([retry.runId]);
  expect(app.external.calls.filter(call => call.path === "/jobstreaming/indeed")).toHaveLength(1);
  expect(app.external.calls.filter(call => call.body?.["operation"] === "fit.qualification-batch")).toHaveLength(1);
  await expect(job.getByText("Fit assessment complete.", { exact: true })).toBeVisible();
  await expect(job.getByRole("button", { name: "Retry unfinished", exact: true })).toHaveCount(0);
  await expect(job.getByRole("button", { name: /^Search and assess fit/ })).toHaveCount(2);
  // A background status read already in flight can return after a refusal,
  // and the new key can be checked before its POST finishes admission.
  expect(misses.filter(response => response.request().headers()["idempotency-key"] === requestId).length).toBeGreaterThanOrEqual(2);
  for (const response of misses) {
    const identity = response.request().headers()["idempotency-key"];
    expect([requestId, correctedKey]).toContain(identity);
    await allowResponseError(response, {
      method: "GET", status: 404, code: "not_found", action: operation, idempotencyKey: identity!, databaseInstanceId: workspace.databaseInstanceId,
    });
  }
});
