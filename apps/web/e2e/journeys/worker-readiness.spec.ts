import { expect, json, test } from "../harness/fixtures.js";
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
