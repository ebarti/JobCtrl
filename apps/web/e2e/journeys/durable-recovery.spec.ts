import { createHash } from "node:crypto";
import {
  test,
  expect,
  json,
  modelCall,
  action,
  completed,
  terminal,
  type ExternalCall,
} from "../harness/fixtures.js";
import { acceptBaseline, createBaseline, createPosting } from "./core-data.js";
import { catalogMatching, typedExtraction } from "./requirements-data.js";

type Source = { source_id: string; text: string };
type Requirements = {
  revision: number;
  requirements: { requirement_id: string }[];
};
const sources = (call: ExternalCall) => call.body["sources"] as Source[];
const citations = (values: Source[]) =>
  values.map((source) => ({ source_id: source.source_id, quote: source.text }));
function extracted(call: ExternalCall) {
  const source = sources(call)[0]!;
  return typedExtraction(call, { requirements: [{ localId: "recovery", text: source.text, definition: "Implement durable workflow recovery" }] });
}

test("a queued Stop survives a Temporal outage and a delayed repeat leaves the next run alone", async ({
  api,
  app,
  page,
  temporal,
}) => {
  const { library } = await createBaseline(api);
  const posting = await createPosting(api, "stop-selected-run");
  const blockerPosting = await json<typeof posting>(api, "post", "/v1/jobs/capture", {
    url: "https://example.com/jobs/stop-queue-blocker", title: "Synthetic Data Engineer",
    company: "Synthetic Queue Company", description: "Build scheduled data imports.", location: "Remote",
  });
  expect(blockerPosting.job_id).not.toBe(posting.job_id);
  const accepted = await acceptBaseline(api, posting.job_id, library.profileVersion);
  const exportAccepted = async () => {
    const response = await api.get(`/v1/resumes/${accepted.resume_id}/export?format=pdf&accepted=true`);
    expect(response.ok()).toBe(true);
    return createHash("sha256").update(await response.body()).digest("hex");
  };
  const acceptedSha = await exportAccepted();
  const settings = await json<{ revision: number }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", { expectedRevision: settings.revision, workerActivitySlots: 1 });
  await app.restartWorker();

  const refresh = (job: typeof posting) => action(api, "requirements.refresh", {
    job_id: job.job_id, expected_posting_revision: job.revision, expected_revision: 0, force: true,
  });
  const blocker = await refresh(blockerPosting);
  const held = await modelCall(app, "requirements.extract");
  const first = await refresh(posting);
  const runPath = `/v1/action-runs/${first.runId}`;
  const cancelPath = `${runPath}/cancel`;
  const current = () => json<{
    status: string; workflowId: string; temporalRunId: string;
    cancellationRequested: boolean; cancellationDelivery?: "pending" | "acknowledged";
  }>(api, "get", runPath);
  const queued = await current();
  expect(queued).toMatchObject({ status: "queued", cancellationRequested: false });
  expect(queued).not.toHaveProperty("cancellationDelivery");
  expect(queued.temporalRunId).toBeTruthy();
  await page.goto(`/runs/${first.runId}`);

  await temporal.pause();
  try {
    const response = page.waitForResponse((value) => new URL(value.url()).pathname === cancelPath && value.request().method() === "POST");
    await page.getByRole("button", { name: "Request stop", exact: true }).click();
    await expect.poll(async () => (await current()).cancellationRequested).toBe(true);
    expect(await current()).toMatchObject({ status: "queued", cancellationDelivery: "pending", temporalRunId: queued.temporalRunId });
    const recorded = await response;
    expect(recorded.status()).toBe(202);
    expect(await recorded.json()).toMatchObject({ runId: first.runId, status: "queued", cancellationRequested: true, cancellationDelivery: "pending" });
    await expect(page.getByText("Stop requested", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Retry stop", exact: true })).toBeVisible();
  } finally {
    await temporal.resume();
  }

  const worker = async () => (await json<{ worker: { healthy: boolean; reason?: string } }>(api, "get", "/v1/health")).worker;
  // With the only activity slot held, Temporal might have no activity poller
  // after restart. Stop only needs the same reachable workflow history.
  await expect.poll(async () => {
    const readiness = await worker();
    return readiness.healthy || readiness.reason === "worker_not_polling";
  }, { timeout: 20_000 }).toBe(true);
  const historyTypes = async () => (await temporal.history(queued.workflowId, queued.temporalRunId)).map((event) => event.eventType);
  expect(await historyTypes()).not.toContain("EVENT_TYPE_WORKFLOW_EXECUTION_CANCEL_REQUESTED");
  expect(await current()).toMatchObject({ status: "queued", cancellationDelivery: "pending" });
  const response = page.waitForResponse((value) => new URL(value.url()).pathname === cancelPath && value.request().method() === "POST");
  await page.getByRole("button", { name: "Retry stop", exact: true }).click();
  const delivered = await response;
  expect(delivered.status()).toBe(200);
  expect(await delivered.json()).toMatchObject({ runId: first.runId, cancellationDelivery: "acknowledged" });
  const stopped = await terminal(api, first.runId);
  expect(stopped).toMatchObject({ status: "cancelled", temporalRunId: queued.temporalRunId, result: null });
  await expect(page.getByText("Status: Cancelled", { exact: true })).toBeVisible();
  const history = await historyTypes();
  expect(history).toContain("EVENT_TYPE_WORKFLOW_EXECUTION_CANCEL_REQUESTED");
  expect(history.at(-1)).toBe("EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED");
  expect(history).not.toContain("EVENT_TYPE_ACTIVITY_TASK_STARTED");
  expect(app.external.calls).toHaveLength(1);

  held.reply(typedExtraction(held, {}));
  await completed(api, blocker.runId);
  await expect.poll(async () => (await worker()).healthy).toBe(true);
  const successor = await refresh(posting);
  expect(successor.runId).not.toBe(first.runId);
  const extraction = await modelCall(app, "requirements.extract");
  expect(extraction.body["context"]).toMatchObject({ refresh_binding: { operation_id: successor.runId } });
  expect(await json(api, "post", cancelPath, {})).toEqual(stopped);
  expect(await json(api, "get", `/v1/action-runs/${successor.runId}`)).toMatchObject({
    runId: successor.runId, status: "running", cancellationRequested: false,
  });
  extraction.reply(extracted(extraction));
  const matching = await modelCall(app, "requirements.match_catalog");
  matching.reply(catalogMatching(matching, { recovery: { verdict: "new" } }));
  const succeeded = await completed(api, successor.runId);
  expect(succeeded.runId).toBe(successor.runId);
  expect(await json(api, "get", `/v1/jobs/${posting.job_id}/requirements`)).toMatchObject(succeeded.result as Requirements);
  expect(await exportAccepted()).toBe(acceptedSha);
});

test("cancellation survives an actual worker kill and its replacement resumes durable work without losing accepted artifacts", async ({
  api,
  app,
}) => {
  const { library } = await createBaseline(api);
  const posting = await createPosting(api, "recovery");
  const first = api.post(`/v1/jobs/${posting.job_id}/requirements`, {
    data: { expected_posting_revision: posting.revision, expected_revision: 0 },
  });
  const extraction = await modelCall(app, "requirements.extract");
  extraction.reply(extracted(extraction));
  const matching = await modelCall(app, "requirements.match_catalog");
  matching.reply(catalogMatching(matching, { recovery: { verdict: "new" } }));
  const initialResponse = await first;
  expect(initialResponse.status(), await initialResponse.text()).toBe(200);
  const accepted: Requirements = await initialResponse.json();
  const resume = await acceptBaseline(
    api,
    posting.job_id,
    library.profileVersion,
  );
  const exported = async () =>
    (
      await api.get(
        `/v1/resumes/${resume.resume_id}/export?format=pdf&accepted=true`,
      )
    ).body();
  const before = createHash("sha256")
    .update(await exported())
    .digest("hex");

  const cancelledRun = await action(api, "requirements.refresh", {
    job_id: posting.job_id,
    expected_posting_revision: posting.revision,
    expected_revision: accepted.revision,
    force: true,
  });
  const held = await modelCall(app, "requirements.extract");
  await json(api, "post", `/v1/action-runs/${cancelledRun.runId}/cancel`, {});
  const replacement = await app.restartWorker();
  expect(replacement.current).not.toBe(replacement.previous);
  await expect
    .poll(() => held.closed, {
      message: "killed worker must release its external request",
    })
    .toBe(true);
  await expect
    .poll(
      async () =>
        (
          await json<{ status: string }>(
            api,
            "get",
            `/v1/action-runs/${cancelledRun.runId}`,
          )
        ).status,
      {
        timeout: 45_000,
        message:
          "recorded cancellation must terminalize on the replacement worker",
      },
    )
    .toBe("cancelled");
  const retained = await json<Requirements>(
    api,
    "get",
    `/v1/jobs/${posting.job_id}/requirements`,
  );
  expect(retained.requirements).toEqual(accepted.requirements);
  expect(retained.revision).toBe(accepted.revision);
  expect(
    createHash("sha256")
      .update(await exported())
      .digest("hex"),
  ).toBe(before);

  // The killed external call has unknown cost. A finite budget must reject
  // further dispatch; cancellation must not invent a free provider receipt.
  const callsBeforeRefusal = app.external.calls.length;
  const denied = await action(api, "requirements.refresh", {
    job_id: posting.job_id,
    expected_posting_revision: posting.revision,
    expected_revision: accepted.revision,
    force: true,
  });
  const deniedResult = await terminal(api, denied.runId);
  expect(deniedResult["status"]).toBe("failed");
  expect(deniedResult["errorCode"]).toBe("spend_accounting_unresolved");
  expect(app.external.calls).toHaveLength(callsBeforeRefusal);
  const health = await json<{ llmSpend: { accountingComplete: boolean; costStatus: string; unresolvedCalls: number; costUsd: number | null } }>(
    api,
    "get",
    "/v1/health",
  );
  expect(health.llmSpend.accountingComplete).toBe(false);
  expect(health.llmSpend).toMatchObject({ costStatus: "unresolved", unresolvedCalls: 1, costUsd: null, accountingBlocked: true });

  // Explicitly select the public unlimited-money policy to exercise fresh
  // work on the replacement. Unknown prior accounting remains visible; lane
  // and token custody remain active. This is not the fixture's default policy.
  const settings = await json<{ revision: number }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", {
    expectedRevision: settings.revision,
    dailyBudgetUsd: 0,
  });
  const resumed = await action(api, "requirements.refresh", {
    job_id: posting.job_id,
    expected_posting_revision: posting.revision,
    expected_revision: accepted.revision,
    force: true,
  });
  expect(resumed.runId).not.toBe(cancelledRun.runId);
  expect(resumed.runId).not.toBe(denied.runId);
  const refreshed = await modelCall(app, "requirements.extract");
  refreshed.reply(extracted(refreshed));
  const comparison = await modelCall(app, "requirements.match_catalog");
  comparison.reply(
    catalogMatching(comparison, {
      recovery: {
        verdict: "equivalent",
        requirementId: accepted.requirements[0]!.requirement_id,
      },
    }),
  );
  const completedRun = await completed(api, resumed.runId);
  expect(completedRun["runId"]).toBe(resumed.runId);
  const final = await json<Requirements>(
    api,
    "get",
    `/v1/jobs/${posting.job_id}/requirements`,
  );
  expect(final.requirements[0]!.requirement_id).toBe(
    accepted.requirements[0]!.requirement_id,
  );
  expect(
    (
      await json<{ llmSpend: { accountingComplete: boolean } }>(
        api,
        "get",
        "/v1/health",
      )
    ).llmSpend.accountingComplete,
  ).toBe(false);
  expect(
    createHash("sha256")
      .update(await exported())
      .digest("hex"),
  ).toBe(before);
});
