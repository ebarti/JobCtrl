import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, json, modelCall, action, completed, terminal, type ApplicationStack } from "../harness/fixtures.js";
import { sources } from "./optional-data.js";

const employer = "Synthetic Platform Company";
const location = "Madrid, Spain";
const title = "Senior Software Engineer | €60K - €80K";
const missing = {
  parse_state: "missing", currency: null, period: "unknown", component: "unknown", minimum_amount: null, maximum_amount: null,
  confidence: "none", warnings: ["no_amount_found"], citations: [], rationale: "The supplied source does not state employer pay.",
};

async function capture(api: APIRequestContext, id: string, text: string) {
  return json<{ job_id: string; revision: number; content_state: string }>(api, "post", "/v1/jobs/capture", {
    url: `https://example.com/jobs/${id}`, title: text, company: employer, location,
  });
}

async function replyToTitle(app: ApplicationStack, jobId: string, revision: number) {
  const pay = await modelCall(app, "compensation.posted_pay");
  const source = sources(pay.body)[0]!;
  expect(source).toEqual({ source_id: `posting:${jobId}:${revision}:title`, text: title });
  expect(pay.body.prompt_version).toBe("posted-compensation-v1");
  expect(pay.body.instructions).toContain("Extract only the employer's stated compensation");
  expect(pay.body.instructions).toContain("Never infer an annual period from magnitude");
  pay.reply({
    parse_state: "parsed_range", currency: "EUR", period: "unknown", component: "unknown", minimum_amount: 60000, maximum_amount: 80000,
    confidence: "high", warnings: ["missing_period"], citations: [{ source_id: source.source_id, quote: "€60K - €80K" }],
    rationale: "The title gives the euro range without a pay period or component.",
  });
}

test("title-only posted pay requires exact model-cited employer bounds", async ({ api, app, page }) => {
  const settings = await json<{ revision: number }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", { expectedRevision: settings.revision, dailyBudgetUsd: 0 });
  const job = await capture(api, "title-pay", title);
  expect(job.content_state).toBe("listing_only");
  const refresh = (id: string) => action(api, "compensation.refresh", { jobId: id, includeEuroTopTech: false });
  const record = `/v1/jobs/${job.job_id}/compensation/posted`;
  const run = await refresh(job.job_id);
  await replyToTitle(app, job.job_id, job.revision);
  (await modelCall(app, "compensation.classification")).invalidJson();
  expect((await terminal(api, run.runId)).status).toBe("failed");
  const accepted = await json<{ determination: { receipt_id: string } }>(api, "get", record);
  expect(accepted).toMatchObject({ recordStatus: "recorded", sourceCurrent: true,
    fact: { sourceField: "title", sourceText: "€60K - €80K", legacyRawSalary: null, currency: "EUR", period: "unknown", component: "unknown",
      minimumAmount: 60000, maximumAmount: 80000, annualizedMinimumAmount: null, annualizedMaximumAmount: null } });
  await page.goto("/jobs?grid=v1&posted_known=source_known");
  await expect(page.getByRole("table", { name: "Jobs table", exact: true }).getByRole("link", { name: title })).toBeVisible();
  const other = await capture(api, "title-metric", "Senior Software Engineer | €60K - €80K project budget");
  const metric = await refresh(other.job_id);
  const nonpay = await modelCall(app, "compensation.posted_pay");
  expect(sources(nonpay.body)[0]).toEqual({ source_id: `posting:${other.job_id}:${other.revision}:title`, text: "Senior Software Engineer | €60K - €80K project budget" });
  nonpay.reply(missing);
  (await modelCall(app, "compensation.classification")).invalidJson();
  await terminal(api, metric.runId);
  expect(await json(api, "get", `/v1/jobs/${other.job_id}/compensation/posted`)).toMatchObject({ fact: { parseState: "missing", legacyRawSalary: null } });
  await json(api, "patch", `/v1/jobs/${job.job_id}`, { expectedRevision: job.revision, title: "Senior Software Engineer | €85K" });
  const correction = await refresh(job.job_id);
  const revised = await modelCall(app, "compensation.posted_pay");
  const source = sources(revised.body)[0]!;
  expect(source.text).toBe("Senior Software Engineer | €85K");
  revised.reply({ ...missing, parse_state: "parsed_range", currency: "EUR", minimum_amount: 85000, maximum_amount: 90000,
    confidence: "high", citations: [{ source_id: source.source_id, quote: "€85K" }] });
  expect((await terminal(api, correction.runId)).status).toBe("failed");
  expect(await json(api, "get", record)).toMatchObject({ sourceCurrent: false, determination: { receipt_id: accepted.determination.receipt_id } });
});

test("a missing description determination can use a raw title once while a stated salary keeps its own authority", async ({ api, app }) => {
  const settings = await json<{ revision: number }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", { expectedRevision: settings.revision, dailyBudgetUsd: 0 });
  const description = "Manage integrations across 3 platforms.";
  const job = await json<{ job_id: string; revision: number }>(api, "post", "/v1/jobs/capture", {
    url: "https://example.com/jobs/title-plus-description", title, description,
  });
  const refresh = () => action(api, "compensation.refresh", { jobId: job.job_id, includeEuroTopTech: false });
  const posted = () => json<{ determination: { receipt_id: string } }>(api, "get", `/v1/jobs/${job.job_id}/compensation/posted`);
  const first = await refresh();
  const body = await modelCall(app, "compensation.posted_pay");
  expect(sources(body.body)[0]?.text).toBe(description);
  body.reply(missing);
  await replyToTitle(app, job.job_id, job.revision);
  (await modelCall(app, "compensation.classification")).invalidJson();
  await terminal(api, first.runId);
  const accepted = await posted();
  expect(accepted).toMatchObject({ fact: { sourceField: "title", minimumAmount: 60000, maximumAmount: 80000 } });
  const retry = await refresh();
  (await modelCall(app, "compensation.classification")).invalidJson();
  await terminal(api, retry.runId);
  expect((await posted()).determination.receipt_id).toBe(accepted.determination.receipt_id);
  const salary = "EUR 92000 base salary per year.";
  const edited = await json<{ revision: number }>(api, "patch", `/v1/jobs/${job.job_id}`, { expectedRevision: job.revision, salary });
  const update = await refresh();
  const primary = await modelCall(app, "compensation.posted_pay");
  const source = sources(primary.body)[0]!;
  expect(source.text).toBe(salary);
  primary.reply({ parse_state: "parsed_range", currency: "EUR", period: "year", component: "base_salary",
    minimum_amount: 92000, maximum_amount: 92000, confidence: "high", warnings: [], citations: [{ source_id: source.source_id, quote: salary }],
    rationale: "The salary field states the annual base amount." });
  (await modelCall(app, "compensation.classification")).invalidJson();
  await terminal(api, update.runId);
  const salaryFact = await posted();
  expect(salaryFact).toMatchObject({ fact: { sourceField: "salary", minimumAmount: 92000, maximumAmount: 92000 } });
  await json(api, "patch", `/v1/jobs/${job.job_id}`, { expectedRevision: edited.revision, salary: "" });
  const interrupted = await refresh();
  const checkedBody = await modelCall(app, "compensation.posted_pay");
  expect(sources(checkedBody.body)[0]?.text).toBe(description);
  checkedBody.reply(missing);
  const interruptedTitle = await modelCall(app, "compensation.posted_pay");
  expect(sources(interruptedTitle.body)[0]?.text).toBe(title);
  interruptedTitle.disconnect();
  expect((await terminal(api, interrupted.runId)).status).toBe("failed");
  const calls = app.external.calls.length;
  const unresolved = await refresh();
  expect(await terminal(api, unresolved.runId)).toMatchObject({ status: "failed", errorCode: "compensation_posted_call_unsettled" });
  expect(app.external.calls.length).toBe(calls);
  expect(await posted()).toMatchObject({ sourceCurrent: false, determination: { receipt_id: salaryFact.determination.receipt_id } });
});

test.describe("title pay persistence", () => {
  test("a retained market estimate and title pay keep their exact sources across restart", async ({ api, app }) => {
    const settings = await json<{ revision: number }>(api, "get", "/v1/settings");
    await json(api, "patch", "/v1/settings", { expectedRevision: settings.revision, dailyBudgetUsd: 0 });
    const job = await capture(api, "legacy-title", title);
    const report = path.join(app.workspace, "owned-pay.json");
    const role = "Senior Software Engineer";
    await writeFile(report, JSON.stringify([{ source: "manual", company: employer, role, location, level: "senior",
      currency: "EUR", period: "year", component: "total_compensation", min: 70000, max: 90000, sampleCount: 5, releaseYear: 2026,
      attribution: "Authored synthetic title upgrade report" }]));
    const options = { observationsJsonPath: report, includeEuroTopTech: false };
    const before = await action(api, "compensation.refresh", { ...options, jobId: job.job_id });
    await replyToTitle(app, job.job_id, job.revision);
    for (const kind of ["posting", "report"]) {
      const call = await modelCall(app, "compensation.classification");
      const source = sources(call.body)[0]!;
      expect(source.source_id).toContain(kind === "posting" ? job.job_id : "manual_reported_compensation:");
      const field = (value: string, quote: string) => ({ value, citations: [{ source_id: source.source_id, quote }], rationale: "The cited source identifies this field." });
      call.reply({ occupation: field("software_engineering", role), seniority: field("senior", role), countries: [field("ES", location)],
        geography_scope: field("locality", location), locality: field("Madrid", location), market_scope: field("company", employer), company_tier: field("unknown", employer) });
    }
    await completed(api, before.runId);
    const market = () => json(api, "get", `/v1/jobs/${job.job_id}/compensation/market`);
    const originalMarket = await market();
    expect(originalMarket).toMatchObject({ recordStatus: "recorded" });
    const originalPosted = await json(api, "get", `/v1/jobs/${job.job_id}/compensation/posted`);
    expect(originalPosted).toMatchObject({ sourceCurrent: true, fact: { sourceField: "title", period: "unknown" } });
    await app.restartWorker();
    await app.restartApi();
    expect(await market()).toEqual(originalMarket);
    expect(await json(api, "get", `/v1/jobs/${job.job_id}/compensation/posted`)).toEqual(originalPosted);
  });
});
