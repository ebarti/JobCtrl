import { test, expect, json, action, terminal, modelCall } from "../harness/fixtures.js";
import { posting, respondProducer } from "./preparation-cohort-data.js";
import { citeSources } from "./requirements-data.js";

test.use({ features: "jobs" });

test.describe("URL import action before capacity queues", () => {
  test.use({ sourceRevision: "17f9ce5be1de2f21735fb27d5dfe8f6d1b7c8118" });
  test("Jobs uses native URL import receipts on the predecessor and never requests the missing queue", async ({ api, app, page }) => {
    const [holder, refused, available] = [911, 912, 913].map(posting);
    let historyReads = 0;
    page.on("request", (request) => { if (new URL(request.url()).pathname === "/v1/jobs/url-imports") historyReads++; });
    const submit = async (url: string) => {
      await page.goto("/jobs");
      await page.getByText("Add a job by URL or text", { exact: true }).click();
      await page.getByText("Import posting URL", { exact: true }).click();
      const form = page.locator("form.jobs-capture__url");
      await expect(form).toContainText("A busy model lane can fail the import without waiting");
      await expect(form.getByRole("link", { name: "View URL import runs" })).toHaveAttribute("href", /workflowType=jobs.capture_url/);
      await expect(page.getByRole("region", { name: "Recent URL imports" })).toHaveCount(0);
      await form.locator("input").fill(url);
      const submitted = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/v1/actions/jobs.capture_url");
      await form.getByRole("button", { name: "Import job", exact: true }).click();
      const response = await submitted;
      expect(response.status()).toBe(202);
      const { runId } = await response.json() as { runId: string };
      await expect(page.getByRole("link", { name: "View import run", exact: true })).toHaveAttribute("href", `/runs/${runId}`);
      return runId;
    };
    const heldRequest = api.post("/v1/jobs/import-url", { data: { url: holder!.url } });
    respondProducer(await app.external.next(), [holder!]);
    const held = await modelCall(app, "page_interpretation");
    try {
      const refusedId = await submit(refused!.url);
      respondProducer(await app.external.next(), [refused!]);
      expect(await terminal(api, refusedId)).toMatchObject({ status: "failed", errorCode: "model_lane_busy" });
      await page.getByRole("link", { name: "View import run", exact: true }).click();
      await expect(page.getByText("model_lane_busy", { exact: true })).toBeVisible();
      expect(app.external.calls.filter((call) => call.path === "/model")).toHaveLength(1);
      respondProducer(held, [holder!]);
      for (const operation of ["posting_extraction", "description_quality"]) respondProducer(await modelCall(app, operation), [holder!]);
      expect((await heldRequest).status()).toBe(201);
      const acceptedId = await submit(available!.url);
      respondProducer(await app.external.next(), [available!]);
      for (const operation of ["page_interpretation", "posting_extraction", "description_quality"]) respondProducer(await modelCall(app, operation), [available!]);
      expect(await terminal(api, acceptedId)).toMatchObject({ status: "succeeded", result: { url: available!.url } });
      await page.reload();
      await page.getByText("Add a job by URL or text", { exact: true }).click();
      await page.getByText("Import posting URL", { exact: true }).click();
      await page.getByRole("link", { name: "View URL import runs" }).click();
      for (const id of [acceptedId, refusedId]) await expect(page.locator(`a[href="/runs/${id}"]`)).toHaveText("jobs.capture_url");
      expect(app.external.calls.filter((call) => call.path === "/model")).toHaveLength(6);
      expect(historyReads).toBe(0);
    } finally {
      if (!held.closed) held.disconnect();
    }
  });
});

test("URL imports wait for occupied model capacity and survive closing Jobs and restarting its worker", async ({ api, app, page }, testInfo) => {
  test.setTimeout(120_000);
  const [holder, target, abandoned] = [901, 902, 903].map(posting);
  const heldRequest = api.post("/v1/jobs/import-url", { data: { url: holder!.url }, timeout: 110_000 });
  respondProducer(await app.external.next(), [holder!]);
  const held = await modelCall(app, "page_interpretation");
  try {
    await page.goto("/jobs");
    await page.getByText("Add a job by URL or text", { exact: true }).click();
    await page.getByText("Import posting URL", { exact: true }).click();
    const form = page.locator("form.jobs-capture__url");
    await form.locator("input").fill(target!.url);
    await form.getByRole("button", { name: "Import job", exact: true }).click();
    respondProducer(await app.external.next(), [target!]);
    const queue = page.getByRole("region", { name: "Recent URL imports" });
    await expect(queue).toContainText("Queued for model capacity", { timeout: 6000 });
    await queue.scrollIntoViewIfNeeded();
    const screenshot = testInfo.outputPath("queued-for-model-capacity.png");
    await page.screenshot({ path: screenshot, animations: "disabled" });
    await testInfo.attach("jobs-import-queued-under-load", { contentType: "image/png", path: screenshot });
    type Import = { runId: string; url: string; status: string; errorCode: string | null; jobId: string | null };
    const read = async () => (await json<{ imports: Import[] }>(api, "get", "/v1/jobs/url-imports")).imports;
    const original = (await read()).find((item) => item.url === target!.url)!;
    const duplicate = await api.post("/v1/actions/jobs.capture_url", { data: { url: target!.url } });
    expect(duplicate.status()).toBe(409);
    expect((await duplicate.json()).error.details.runId).toBe(original.runId);
    const other = await action(api, "jobs.capture_url", { url: abandoned!.url });
    respondProducer(await app.external.next(), [abandoned!]);
    await expect.poll(async () => (await read()).find((item) => item.runId === other.runId)?.status).toBe("waiting_for_capacity");
    await api.post(`/v1/action-runs/${other.runId}/cancel`, { data: {} });
    expect(await terminal(api, other.runId)).toMatchObject({ status: "cancelled" });
    const browser = page.context();
    await page.close();
    await app.restartWorker();
    const recoveredFetch = await app.external.next({ timeout: 50_000 });
    respondProducer(recoveredFetch, [target!]);
    const reopened = await browser.newPage();
    await reopened.goto("/jobs");
    await reopened.getByText("Add a job by URL or text", { exact: true }).click();
    const recoveredQueue = reopened.getByRole("region", { name: "Recent URL imports" });
    await expect(recoveredQueue).toContainText("Queued for model capacity");
    const field = (value: string) => ({ value, citations: citeSources(held, ["rendered_page"]), rationale: "Explicit source-bound classification for the held request." });
    held.reply({ availability: field("unknown"), page_kind: field("listing"), access_state: field("clear"), apply_control: field("unknown") });
    expect((await (await heldRequest).json()).error.code).toBe("manual_capture_required");
    for (const op of ["page_interpretation", "posting_extraction", "description_quality"])
      respondProducer(await modelCall(app, op), [target!]);
    const finished = await terminal(api, original.runId);
    expect(finished).toMatchObject({ status: "succeeded", result: { url: target!.url, title: target!.title } });
    const saved = (finished.result as { job_id: string }).job_id;
    await expect(recoveredQueue.getByRole("link", { name: "Open job" })).toHaveAttribute("href", new RegExp(saved));
    const history = await json<{ observations: unknown[] }>(api, "get", `/v1/jobs/${saved}/snapshots`);
    expect(history.observations).toHaveLength(1);
    expect(app.external.calls.filter((call) => call.path === "/model")).toHaveLength(4);
  } finally {
    if (!held.closed) held.disconnect();
    await heldRequest.catch(() => {});
  }
});

test("URL import reuses settled model stages and refuses to repeat an interrupted paid call", async ({ api, app }) => {
  test.setTimeout(110_000);
  const target = posting(904);
  const request = { data: { url: target.url }, headers: { "Idempotency-Key": "synthetic-interrupted-import" } };
  const submitted = await api.post("/v1/actions/jobs.capture_url", request);
  expect(submitted.status()).toBe(202);
  const { runId } = await submitted.json() as { runId: string };
  respondProducer(await app.external.next(), [target]);
  respondProducer(await modelCall(app, "page_interpretation"), [target]);
  const interrupted = await modelCall(app, "posting_extraction");
  try {
    await app.restartWorker();
    respondProducer(await app.external.next({ timeout: 50_000 }), [target]);
    expect(await terminal(api, runId)).toMatchObject({ status: "failed", errorCode: "import_call_unsettled" });
    expect(await (await api.post("/v1/actions/jobs.capture_url", request)).json()).toMatchObject({ runId, status: "failed" });
    expect(app.external.calls.filter((call) => call.path === "/model").map((call) => call.body["operation"]))
      .toEqual(["page_interpretation", "posting_extraction"]);
    expect((await json<{ total: number }>(api, "get", "/v1/jobs")).total).toBe(0);
  } finally {
    if (!interrupted.closed) interrupted.disconnect();
  }
});

test("posting fetch refusals retain safe typed evidence and accepted sources without model calls or implicit retries", async ({ api, app }, testInfo) => {
  const posting = await json<{ job_id: string; revision: number }>(api, "post", "/v1/jobs/capture", {
    url: "https://example.com/jobs/source-fetch-evidence",
    title: "Synthetic Source Recovery Engineer",
    company: "Synthetic Source Company",
    description: "Retain the accepted operational source while a later fetch needs review.",
  });
  type History = { snapshots: unknown[]; observations: unknown[]; attempts: { failure_code: string; data: Record<string, unknown> }[] };
  const accepted = await json<History>(api, "get", `/v1/jobs/${posting.job_id}/snapshots`);
  const remoteBody = "Private remote diagnostic text must not be copied into acquisition evidence.";
  const cases = [
    { status: 429, code: "posting_fetch_blocked", kind: "blocked", reason_code: "rate_limited" },
    { status: 503, code: "posting_fetch_unavailable", kind: "unavailable", reason_code: "unknown" },
    { status: null, code: "posting_fetch_failed", kind: "unknown", reason_code: "unknown" },
  ] as const;
  const evidence: Record<string, unknown>[] = [];
  for (const [index, expected] of cases.entries()) {
    const started = await action(api, "jobs.refresh", { job_id: posting.job_id, expectedRevision: posting.revision });
    const fetch = await app.external.next();
    expect(fetch.path).toBe("/posting-page");
    expect(fetch.body).toEqual({ url: "https://example.com/jobs/source-fetch-evidence" });
    if (expected.status === null) fetch.disconnect();
    else fetch.respond({ error: remoteBody }, expected.status);
    expect(await terminal(api, started.runId)).toMatchObject({ status: "failed", errorCode: expected.code });
    const retained = await json<History>(api, "get", `/v1/jobs/${posting.job_id}/snapshots`);
    expect(retained.snapshots).toEqual(accepted.snapshots);
    expect(retained.observations).toEqual(accepted.observations);
    expect(retained.attempts).toHaveLength(index + 1);
    const attempt = retained.attempts[0]!;
    expect(attempt.failure_code).toBe(expected.code);
    expect(attempt.data).toEqual({ captureEvidence: null, captureFailure: {
      stage: "posting_fetch", kind: expected.kind, reason_code: expected.reason_code,
    } });
    expect(JSON.stringify(attempt.data)).not.toContain(remoteBody);
    expect(app.external.calls.filter((call) => call.path === "/posting-page")).toHaveLength(index + 1);
    expect(app.external.calls.filter((call) => call.path === "/model")).toHaveLength(0);
    evidence.push({ runId: started.runId, code: attempt.failure_code, data: attempt.data });
  }
  const beforeReads = app.external.calls.length;
  await json(api, "get", `/v1/jobs/${posting.job_id}`);
  await json(api, "get", `/v1/jobs/${posting.job_id}/snapshots`);
  expect(app.external.calls).toHaveLength(beforeReads);
  await testInfo.attach("posting-fetch-failure-evidence", { contentType: "application/json",
    body: Buffer.from(JSON.stringify({ jobId: posting.job_id, modelCalls: 0, attempts: evidence }, null, 2)) });
});
