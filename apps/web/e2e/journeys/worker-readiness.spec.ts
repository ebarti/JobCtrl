import { completed, expect, json, test } from "../harness/fixtures.js";
import { posting } from "./preparation-cohort-data.js";

type Health = {
  databaseInstanceId: string;
  runtimeIdentity: { workspace: string; build: string; namespace: string; history: string };
  worker: { healthy: boolean; pid: number; build: string; heartbeatAt: string; reason?: string };
};

test("workspace identity survives a worker restart and refuses a mismatched history before writing", async ({ app, api, page }) => {
  const original = await json<Health>(api, "get", "/v1/health");
  expect(original.runtimeIdentity.workspace).toBe(app.workspace);
  expect(original.runtimeIdentity.build).toMatch(/^[a-f0-9]{64}$/);
  expect(original.worker).toMatchObject({ healthy: true, build: original.runtimeIdentity.build });
  await page.goto("/jobs");
  await expect(page.getByText("Workspace workspace", { exact: true })).toHaveAttribute("title", app.workspace);
  const saved = await json<{ job_id: string }>(api, "post", "/v1/jobs/capture", posting(158));
  const alternate = await app.alternateNamespaceApi("wrong-namespace");
  const mismatch = await (await api.get(`${alternate}/v1/health`)).json();
  expect(mismatch.databaseInstanceId).toBe(original.databaseInstanceId);
  expect(mismatch.worker).toMatchObject({ healthy: false, reason: "workflow_history_mismatch" });
  const refused = await api.post(`${alternate}/v1/jobs/capture`, { headers: { Origin: alternate }, data: posting(159) });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error.code).toBe("workflow_history_mismatch");

  const replacement = await app.restartWorker();
  const restarted = await json<Health>(api, "get", "/v1/health");
  expect(restarted.runtimeIdentity).toEqual(original.runtimeIdentity);
  expect(restarted.worker).toMatchObject({ healthy: true, pid: replacement.current, build: original.worker.build });
  expect((await json<{ jobs: { job_id: string }[] }>(api, "get", "/v1/jobs")).jobs.map(job => job.job_id)).toEqual([saved.job_id]);
});

test("dispatch readiness refuses an outage and retries the same action after service restoration", async ({ app, api, page, temporal }) => {
  test.setTimeout(90_000);
  const name = "compensation.refresh_all";
  const send = (key: string) => api.post(`/v1/actions/${name}`, { data: {}, headers: { "Idempotency-Key": key } });
  const health = () => json<Health>(api, "get", "/v1/health");
  const before = await health();
  const first = await send("before-outage");
  expect(first.status()).toBe(202);
  const firstRun = await first.json();
  const firstResult = await completed(api, firstRun.runId);

  await temporal.pause();
  try {
    await expect.poll(async () => {
      const { worker } = await health();
      return worker.pid === before.worker.pid && worker.heartbeatAt > before.worker.heartbeatAt && !worker.healthy && worker.reason;
    }, { timeout: 18_000 }).toBe("workflow_service_unavailable");
    const diagnostic = await json<{ worker: { healthy: boolean } }>(api, "get", "/v1/telemetry/pipeline");
    expect(diagnostic.worker.healthy).toBe(false);
    await page.goto("/jobs");
    const warning = page.getByRole("alert").filter({ hasText: "The workflow service is unavailable." });
    await expect(warning).toBeVisible();
    await warning.getByRole("button", { name: "Check again" }).click();
    const refused = await send("manual-retry");
    expect(refused.status()).toBe(503);
    expect((await refused.json()).error.code).toBe("workflow_service_unavailable");
    expect((await api.get(`/v1/action-runs/by-idempotency-key?action=${name}`, { headers: { "Idempotency-Key": "manual-retry" } })).status()).toBe(404);
    expect(await (await send("before-outage")).json()).toMatchObject({ runId: firstRun.runId, status: "succeeded" });
  } finally {
    await temporal.resume();
  }
  await expect.poll(async () => (await health()).worker.healthy, { timeout: 45_000 }).toBe(true);
  const [retry, repeated] = await Promise.all([send("manual-retry"), send("manual-retry")]);
  expect([retry.status(), repeated.status()]).toEqual([202, 202]);
  const retryRun = await retry.json();
  expect(await repeated.json()).toMatchObject({ runId: retryRun.runId, workflowId: retryRun.workflowId });
  expect((await completed(api, retryRun.runId)).result).toEqual(firstResult.result);
  expect(await (await send("manual-retry")).json()).toMatchObject({ runId: retryRun.runId, workflowId: retryRun.workflowId, status: "succeeded" });
  const recorded = await json<{ runs: unknown[] }>(api, "get", `/v1/action-runs?action=${name}`);
  expect(recorded.runs).toHaveLength(2);

  await app.restartWorker("jobs");
  const disabled = await send("missing-feature");
  expect(disabled.status()).toBe(503);
  expect((await disabled.json()).error.code).toBe("worker_action_unavailable");
  expect(app.external.calls).toHaveLength(0);
});
