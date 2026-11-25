import path from "node:path";

import { expect, json, modelCall, test } from "../harness/fixtures.js";
import { posting, respondProducer } from "./preparation-cohort-data.js";

type Health = {
  databaseInstanceId: string;
  runtimeIdentity: { workspace: string; build: string; namespace: string; history: string };
  worker: { healthy: boolean; pid: number; build: string; heartbeatAt: string; reason?: string };
};

test("workspace identity and saved work survive a worker restart", async ({ app, api, page }) => {
  const original = await json<Health>(api, "get", "/v1/health");
  expect(original.runtimeIdentity.workspace).toBe(app.workspace);
  expect(original.runtimeIdentity.build).toMatch(/^[a-f0-9]{64}$/);
  expect(original.worker).toMatchObject({ healthy: true, build: original.runtimeIdentity.build });
  await page.goto("/jobs");
  await expect(page.getByText("Workspace workspace", { exact: true })).toHaveAttribute("title", app.workspace);
  const saved = await json<{ job_id: string }>(api, "post", "/v1/jobs/capture", posting(158));

  const replacement = await app.restartWorker();
  const restarted = await json<Health>(api, "get", "/v1/health");
  expect(restarted.runtimeIdentity).toEqual(original.runtimeIdentity);
  expect(restarted.worker).toMatchObject({ healthy: true, pid: replacement.current, build: original.worker.build });
  expect((await json<{ jobs: { job_id: string }[] }>(api, "get", "/v1/jobs")).jobs.map(job => job.job_id)).toEqual([saved.job_id]);
});

test("a database outage becomes unavailable and recovers without losing accepted work", async ({ app, api, postgres }) => {
  test.setTimeout(90_000);
  const saved = await json<{ job_id: string }>(api, "post", "/v1/jobs/capture", posting(160));
  await postgres.pause();
  try {
    await expect.poll(async () => {
      try { return (await api.get("/v1/health", { timeout: 2000 })).ok(); }
      catch { return false; }
    }, { timeout: 15_000 }).toBe(false);
  } finally {
    await postgres.resume();
  }
  await expect.poll(async () => {
    try { return (await api.get("/v1/health", { timeout: 2000 })).ok(); }
    catch { return false; }
  }, { timeout: 45_000 }).toBe(true);
  expect((await json<{ jobs: { job_id: string }[] }>(api, "get", "/v1/jobs")).jobs.map(job => job.job_id)).toContain(saved.job_id);
  await app.restartWorker();
});


test("a logical backup cannot replay a provider action on a different PostgreSQL database", async ({ app, api }) => {
  test.setTimeout(120_000);
  const original = await json<Health>(api, "get", "/v1/health");
  const row = posting(161);
  const admitted = await json<{ runId: string }>(api, "post", "/v1/actions/jobs.capture_url", { url: row.url });
  const page = await app.external.next({ match: (call) => call.path === "/posting-page" });
  respondProducer(page, [row]);
  const heldModelRequest = await modelCall(app, "page_interpretation");
  const archiveName = "held-provider-work.pgdump";
  try {
    const backup = await app.cli(["backup", "--output", path.join(app.directory, archiveName)]);
    expect(backup.exitCode, backup.stderr).toBe(0);
  } finally {
    respondProducer(heldModelRequest, [row]);
  }
  respondProducer(await modelCall(app, "posting_extraction"), [row]);
  respondProducer(await modelCall(app, "description_quality"), [row]);
  const runPath = `/v1/action-runs/${admitted.runId}`;
  await expect.poll(() => json<{ status: string }>(api, "get", runPath).then((run) => run.status)).toBe("succeeded");
  const modelCalls = app.external.calls.filter((call) => call.path === "/model").length;
  expect(modelCalls).toBeGreaterThan(0);

  const clone = await app.inspectLogicalBackup(archiveName, admitted.runId);
  expect(clone.archived).toEqual(["running", "PENDING"]);
  expect(clone.afterTrial).toEqual(clone.archived);
  expect(clone.cli.exitCode).toBe(1);
  expect(JSON.parse(clone.cli.stderr).error.code).toBe("workspace_restore_mismatch");
  expect(clone.api.exitCode).toBe(1);
  expect(clone.api.stderr).toContain("workspace_restore_mismatch");
  expect(clone.worker.exitCode).toBe(1);
  expect(clone.worker.stderr).toContain("This workspace is bound to another PostgreSQL database");
  expect(app.external.calls.filter((call) => call.path === "/model")).toHaveLength(modelCalls);
  expect(await json<Health>(api, "get", "/v1/health")).toMatchObject({
    databaseInstanceId: original.databaseInstanceId,
    worker: { healthy: true },
  });
  expect(await json<{ status: string }>(api, "get", runPath)).toMatchObject({ status: "succeeded" });
});
