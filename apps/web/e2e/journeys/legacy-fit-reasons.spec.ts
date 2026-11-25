import { indeedPage } from "./indeed-data.js";
import { action, completed, expect, json, modelCall, test } from "../harness/fixtures.js";
import { createBaseline } from "./core-data.js";
import { posting, respondProducer } from "./preparation-cohort-data.js";
import { typedExtraction } from "./requirements-data.js";

test("the Jobs grid identifies a run's source-bound language decision before and after it skips Fit", async ({ api, app, page }) => {
  await createBaseline(api);
  const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["indeed"], hoursOld: 0, newJobLimit: 11, resultsPerSite: 11 });
  const started = await action(api, "discovery.search", { queries: ["Synthetic engineer"], locations: [{ location: "Madrid", remote: true }] });
  const target = { ...posting(1200), description: "Maintain durable workflows. Mantener la recuperación de los flujos de trabajo." };
  const siblings = Array.from({ length: 10 }, (_, i) => posting(1201 + i));
  const source = await app.external.next();
  expect(source.path).toBe("/jobstreaming/indeed");
  source.respond(indeedPage({ jobs: [target, ...siblings], complete: true, cursor: null }));
  respondProducer(await app.external.next({ match: (call) => call.path === "/posting-page" && call.body.url === target.url }), [target]);
  for (const operation of ["page_interpretation", "posting_extraction", "description_quality", "jobs.role_analysis", "requirements.extract"]) {
    const call = await app.external.next({ match: (item) => item.path === "/model" && item.body.operation === operation });
    respondProducer(call, [{ ...target, unsupported: true }]);
  }
  const runPath = `/v1/preparation/runs/${started.runId}`;
  type Step = { jobId: string; stage: string; status: string; result: Record<string, unknown> | null };
  const run = await json<{ targetRoute: string; jobIds: string[]; steps: Step[] }>(api, "get", runPath);
  expect(run.targetRoute).toBe("per_job");
  const id = run.jobIds[0]!;
  const saved = await json<{ revision: number; source_hash: string }>(api, "get", `/v1/jobs/${id}`);
  const requirements = await json<{ revision: number }>(api, "get", `/v1/jobs/${id}/requirements`);
  expect(requirements).toMatchObject({ status: "unsupported_language", posting_revision: saved.revision, posting_hash: saved.source_hash, stale: false });
  expect(run.steps).toContainEqual(expect.objectContaining({ jobId: id, stage: "requirements", status: "succeeded", result: expect.objectContaining({
    revision: requirements.revision, postingRevision: saved.revision, postingHash: saved.source_hash, status: "unsupported_language",
  }) }));
  expect(run.steps.find((step) => step.jobId === id && step.stage === "fit")).toBeUndefined();
  let gridRequirementsReads = 0;
  const countRead = (request: { url(): string }) => { if (/^\/v1\/jobs\/[^/]+\/requirements$/.test(new URL(request.url()).pathname)) gridRequirementsReads++; };
  page.on("request", countRead);
  await page.goto("/jobs?fit_state=unassessed");
  const row = page.getByRole("row").filter({ hasText: target.title });
  await expect(row.getByRole("link", { name: "Non-English in this run", exact: true })).toHaveAttribute("href", `/runs/${started.runId}`);
  for (const sibling of siblings) {
    const fetch = await app.external.next({ match: (call) => call.path === "/posting-page" && call.body.url === sibling.url });
    expect(fetch.path).toBe("/posting-page");
    expect(fetch.body.url).toBe(sibling.url);
    fetch.respond({}, 503);
  }
  expect((await completed(api, started.runId)).result).toMatchObject({ preparation: { assessedJobs: 0, skippedJobs: 1, failedJobs: 10 } });
  const terminal = await json<{ steps: Step[] }>(api, "get", runPath);
  expect(terminal.steps).toContainEqual(expect.objectContaining({ stage: "fit", status: "skipped", jobId: id, result: expect.objectContaining({ skip: "unsupported_posting_language", requirements_revision: requirements.revision }) }));
  await expect(row.getByRole("link", { name: "Skipped in this run · non-English", exact: true })).toHaveAttribute("href", `/runs/${started.runId}`);
  expect(gridRequirementsReads).toBe(0);
  page.off("request", countRead);
  await row.getByRole("link", { name: target.title, exact: true }).click();
  const fitPanel = page.getByRole("region", { name: "Person fit", exact: true });
  await expect(fitPanel).toContainText("Person fit was skipped because this posting was identified as non-English");
  await expect(fitPanel.getByRole("link", { name: "View preparation run" })).toHaveAttribute("href", `/runs/${started.runId}`);

  const reassessment = json<{ revision: number }>(api, "post", `/v1/jobs/${id}/requirements`, {
    expected_posting_revision: saved.revision, expected_revision: requirements.revision, force: true,
  });
  const extraction = await modelCall(app, "requirements.extract");
  extraction.reply(typedExtraction(extraction, { classification: "english" }));
  const current = await reassessment;
  expect(current).toMatchObject({ status: "complete", posting_revision: saved.revision, posting_hash: saved.source_hash, stale: false });
  expect(current.revision).toBeGreaterThan(requirements.revision);
  await page.reload();
  await expect(fitPanel).toContainText("No person-fit assessment has been recorded yet.");
  await page.goto("/jobs?fit_state=unassessed");
  await expect(row.getByRole("link", { name: "Skipped in this run · non-English", exact: true })).toHaveAttribute("href", `/runs/${started.runId}`);

  const updated = { ...target, description: "A new source describes a different job." };
  const refresh = await action(api, "jobs.refresh", { job_id: id, expectedRevision: saved.revision });
  respondProducer(await app.external.next(), [updated]);
  for (const operation of ["page_interpretation", "posting_extraction", "description_quality"]) respondProducer(await modelCall(app, operation), [updated]);
  await completed(api, refresh.runId);
  await expect(row.getByRole("cell", { name: "Not assessed", exact: true })).toBeVisible();
  await row.getByRole("link", { name: target.title, exact: true }).click();
  await expect(fitPanel).toContainText("No person-fit assessment has been recorded yet.");
});
