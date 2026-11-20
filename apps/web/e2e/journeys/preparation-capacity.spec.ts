import { indeedPage } from "./indeed-data.js";
import type { APIRequestContext } from "@playwright/test";
import { action, completed, expect, json, modelCall, terminal, test, type ApplicationStack } from "../harness/fixtures.js";
import { createBaseline } from "./core-data.js";
import { authoredPartition } from "./consolidation-data.js";
import { COMMON_DEMAND, posting, respondProducer, type CohortPosting } from "./preparation-cohort-data.js";
import { catalogContext, COHORT_NORMALIZATION_PROMPT_VERSION, REFRESH_NORMALIZATION_PROMPT_VERSION, typedExtraction } from "./requirements-data.js";
import { serveQualification } from "./search-assessment-data.js";

async function capturePosting(api: APIRequestContext, index: number, description?: string) {
  const row = posting(index);
  return json<{ job_id: string; revision: number }>(api, "post", "/v1/jobs/capture", {
    url: row.url, title: row.title, company: row.company, description: description ?? row.description,
  });
}

async function waitEvents(api: APIRequestContext, runId: string, stage: string, reason: string) {
  const query = new URLSearchParams({ aggregateId: runId, type: "PreparationWaitingForCapacity", stage });
  const { events } = await json<{ events: { payload: { reason: string } }[] }>(api, "get", `/v1/events?${query}`);
  return events.filter((event) => event.payload.reason === reason).length;
}

async function servePostingAndRole(app: ApplicationStack, target: CohortPosting) {
  for (const expected of ["/posting-page", "page_interpretation", "posting_extraction", "description_quality", "jobs.role_analysis"]) {
    const call = await app.external.next();
    expect(call.path === "/model" ? call.body["operation"] : call.path).toBe(expected);
    respondProducer(call, [target]);
  }
}

async function publishSingleDemand(app: ApplicationStack, prompt: string) {
  const matching = await modelCall(app, "requirements.match_catalog");
  expect(matching.body["prompt_version"]).toBe(prompt);
  const input = catalogContext(matching);
  expect(input.incoming).toHaveLength(1);
  const member = input.incoming[0]!;
  matching.reply(authoredPartition(matching, [{ groupId: "recovery", memberIds: [member.member_id],
    category: "professional_experience", name: COMMON_DEMAND, definition: COMMON_DEMAND }],
  [{ groupId: "recovery", definition: COMMON_DEMAND, jobIds: [member.job_id] }]));
  return member.job_id;
}

test("a search waiting for the Requirements lane survives worker replacement, cancellation of another waiter, and scores once", async ({ api, app }) => {
  test.setTimeout(120_000);
  const { library } = await createBaseline(api);
  const settings = await json<{ revision: number }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", { expectedRevision: settings.revision, dailyBudgetUsd: 0 });
  const holder = await capturePosting(api, 948, "Mantener los sistemas de la empresa.");
  const abandoned = await capturePosting(api, 949);
  const heldRequest = api.post(`/v1/jobs/${holder.job_id}/requirements`, {
    data: { expected_posting_revision: holder.revision, expected_revision: 0 }, timeout: 110_000,
  });
  const held = await modelCall(app, "requirements.extract");
  const target = posting(951);
  const search = await action(api, "discovery.search", {
    queries: ["Synthetic reliability engineer"], locations: [{ location: "Madrid", remote: true }],
    boards: ["indeed"], newJobLimit: 1,
  });
  const source = await app.external.next();
  expect(source.path).toBe("/jobstreaming/indeed");
  source.respond(indeedPage({ jobs: [target], cursor: null, complete: true }));
  await servePostingAndRole(app, target);
  await expect.poll(() => waitEvents(api, search.runId, "requirements_extract", "model_lane_busy")).toBe(1);
  const cancel = await action(api, "preparation.run", { recipe: "score", job_ids: [abandoned.job_id], resume_mode: "baseline" });
  await expect.poll(() => waitEvents(api, cancel.runId, "requirements", "model_lane_busy")).toBe(1);
  await json(api, "post", `/v1/action-runs/${cancel.runId}/cancel`, {});
  expect(await terminal(api, cancel.runId)).toMatchObject({ status: "cancelled" });
  const replacement = await app.restartWorker();
  expect(replacement.current).not.toBe(replacement.previous);
  await expect.poll(() => waitEvents(api, search.runId, "requirements_extract", "model_lane_busy"), { timeout: 50_000 }).toBe(2);
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "requirements.extract")).toHaveLength(1);
  held.reply(typedExtraction(held, { classification: "non_english", status: "unsupported_language" }));
  expect((await heldRequest).ok()).toBe(true);
  respondProducer(await modelCall(app, "requirements.extract"), [target]);
  const jobId = await publishSingleDemand(app, COHORT_NORMALIZATION_PROMPT_VERSION);
  await serveQualification(app, library);
  expect((await completed(api, search.runId)).result).toMatchObject({ newJobs: 1, preparation: { assessedJobs: 1, failedJobs: 0 } });
  expect(await json(api, "get", `/v1/jobs/${jobId}/fit`)).toMatchObject({ current: true, score: { revision: 1 } });
  const operations = app.external.calls.map((call) => call.body?.["operation"]);
  expect(operations.filter((name) => name === "requirements.extract")).toHaveLength(2);
  for (const name of ["jobs.role_analysis", "requirements.match_catalog", "fit.qualification-batch"]) {
    expect(operations.filter((candidate) => candidate === name)).toHaveLength(1);
  }
  expect(app.external.calls.filter((call) => call.path === "/jobstreaming/indeed")).toHaveLength(1);
});

test("a search above the cohort cutoff resumes the per-job Requirements stage and completes the entire frozen selection", async ({ api, app }) => {
  test.setTimeout(120_000);
  const { library } = await createBaseline(api);
  const settings = await json<{ revision: number }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", { expectedRevision: settings.revision, dailyBudgetUsd: 0 });
  const holder = await capturePosting(api, 970, "Revisar procedimientos del almacén.");
  const heldRequest = api.post(`/v1/jobs/${holder.job_id}/requirements`, {
    data: { expected_posting_revision: holder.revision, expected_revision: 0 }, timeout: 110_000,
  });
  const held = await modelCall(app, "requirements.extract");
  const rows = [posting(971), ...Array.from({ length: 10 }, (_, index) => ({
    ...posting(972 + index), description: `Gestionar el equipo de recuperación número ${index + 1}.`, unsupported: true,
  }))];
  const run = await action(api, "discovery.search", {
    queries: ["Synthetic reliability engineer"], locations: [{ location: "Madrid", remote: true }],
    boards: ["indeed"], newJobLimit: rows.length, resultsPerSite: rows.length,
  });
  const source = await app.external.next();
  expect(source.path).toBe("/jobstreaming/indeed");
  source.respond(indeedPage({ jobs: rows.map(({ job_key, url, title, company, description, location }) =>
    ({ job_key, url, title, company, description, location })), cursor: null, complete: true }));
  await servePostingAndRole(app, rows[0]!);
  await expect.poll(() => waitEvents(api, run.runId, "requirements", "model_lane_busy")).toBe(1);
  const frozen = await json<{ jobIds: string[]; targetRoute: string }>(api, "get", `/v1/preparation/runs/${run.runId}`);
  expect(frozen.targetRoute).toBe("per_job");
  expect(frozen.jobIds).toHaveLength(rows.length);
  held.reply(typedExtraction(held, { classification: "non_english", status: "unsupported_language" }));
  expect((await heldRequest).ok()).toBe(true);
  respondProducer(await modelCall(app, "requirements.extract"), [rows[0]!]);
  const jobId = await publishSingleDemand(app, REFRESH_NORMALIZATION_PROMPT_VERSION);
  for (const row of rows.slice(1)) {
    await servePostingAndRole(app, row);
    respondProducer(await modelCall(app, "requirements.extract"), [row]);
  }
  await serveQualification(app, library);
  expect((await completed(api, run.runId)).result).toMatchObject({
    newJobs: rows.length, preparation: { assessedJobs: 1, failedJobs: 0, skippedJobs: 10 },
  });
  expect(await json(api, "get", `/v1/jobs/${jobId}/fit`)).toMatchObject({ current: true });
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "requirements.extract")).toHaveLength(rows.length + 1);
});

test("a preparation waiting on monetary serialization respects the actual settled spend limit without dispatch", async ({ api, app }) => {
  const settings = await json<{ revision: number }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", { expectedRevision: settings.revision, dailyBudgetUsd: 1 });
  const holder = await capturePosting(api, 958, "Mantener los sistemas de la empresa.");
  const target = await capturePosting(api, 959);
  const heldRequest = api.post(`/v1/jobs/${holder.job_id}/requirements`, {
    data: { expected_posting_revision: holder.revision, expected_revision: 0 },
  });
  const held = await modelCall(app, "requirements.extract");
  const run = await action(api, "preparation.run", { recipe: "analyze", job_ids: [target.job_id] });
  await expect.poll(() => waitEvents(api, run.runId, "role_analysis", "model_budget_busy")).toBe(1);
  held.respond({ value: typedExtraction(held, { classification: "non_english", status: "unsupported_language" }),
    usage: { input_tokens: 10, output_tokens: 5, cost_usd: 1 } });
  expect((await heldRequest).ok()).toBe(true);
  expect(await terminal(api, run.runId)).toMatchObject({ status: "failed", errorCode: "preparation_partial" });
  const detail = await json<{ steps: { stage: string; status: string; errorCode: string }[] }>(api, "get", `/v1/preparation/runs/${run.runId}`);
  expect(detail.steps).toContainEqual(expect.objectContaining({ stage: "role_analysis", status: "failed", errorCode: "role_analysis_failed" }));
  const history = await json<{ attempts: { failure_code: string; data: { failures: { code: string }[] } }[] }>(
    api, "get", `/v1/jobs/${target.job_id}/snapshots`);
  const attempt = history.attempts.find((item) => item.failure_code === "role_analysis_failed");
  expect(attempt?.data.failures).toMatchObject([{ code: "spend_limit_reached" }]);
  expect(app.external.calls.filter((call) => call.path === "/model")).toHaveLength(1);
});
