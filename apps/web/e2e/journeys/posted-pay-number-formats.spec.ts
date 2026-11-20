import { test, expect, action, json, modelCall, terminal, type ApplicationStack } from "../harness/fixtures.js";
import { sources } from "./optional-data.js";

async function replyToPay(app: ApplicationStack, field: string, text: string, quote: string, minimum: number | null, maximum: number | null, period = "unknown") {
  const call = await modelCall(app, "compensation.posted_pay");
  const source = sources(call.body)[0]!;
  expect(source.source_id.endsWith(`:${field}`)).toBe(true);
  expect(source.text).toBe(text);
  call.reply({
    parse_state: minimum === null && maximum === null ? "ambiguous" : "parsed_range", currency: "EUR",
    period, component: "unknown", minimum_amount: minimum, maximum_amount: maximum,
    confidence: minimum === null ? "low" : "high", warnings: [], citations: [{ source_id: source.source_id, quote }],
    rationale: "This determination is bound to the quoted employer text.",
  });
}

test.describe("period-grouped posted salary upgrade", () => {
  test.use({ sourceRevision: "c74d8ae3e43c55ae57c6d2bcb9e024c42f27d708" });
  test("Jobs publishes the original period-grouped pay receipt and keeps a verified decimal amount", async ({ api, app, page }) => {
    const settings = await json<{ revision: number }>(api, "get", "/v1/settings");
    await json(api, "patch", "/v1/settings", { expectedRevision: settings.revision, dailyBudgetUsd: 0 });
    const capture = (slug: string, title: string, salary: string) => json<{ job_id: string }>(api, "post", "/v1/jobs/capture", {
      url: `https://example.com/jobs/${slug}`, title, salary, company: "Synthetic Employer",
    });
    const refresh = (id: string) => action(api, "compensation.refresh", { jobId: id, includeEuroTopTech: false });
    const posted = (id: string) => json<{ recordStatus: string; determination: { receipt_id: string; created_at: string } }>(api, "get", `/v1/jobs/${id}/compensation/posted`);
    const decimalText = "Hourly base pay EUR 55.000.";
    const decimal = await capture("decimal-rate", "Synthetic precision role", decimalText);
    const decimalRun = await refresh(decimal.job_id);
    await replyToPay(app, "salary", decimalText, "55.000", 55, 55, "hour");
    (await modelCall(app, "compensation.classification")).invalidJson();
    await terminal(api, decimalRun.runId);
    const original = await posted(decimal.job_id);
    expect(original).toMatchObject({ recordStatus: "recorded", fact: { minimumAmount: 55, maximumAmount: 55 } });
    const annualText = "La retribución anual indicada es de 55.000€.";
    const annual = await capture("period-grouped-rate", "Synthetic posted salary", annualText);
    const failed = await refresh(annual.job_id);
    await replyToPay(app, "salary", annualText, annualText, 55000, 55000, "year");
    expect((await terminal(api, failed.runId)).status).toBe("failed");
    expect((await posted(annual.job_id)).recordStatus).toBe("not_recorded");
    const beforeUpgrade = new Date().toISOString();
    const postedCalls = () => app.external.calls.filter((call) => call.body.operation === "compensation.posted_pay").length;
    const before = postedCalls();
    await app.upgradeSource();
    expect(await posted(decimal.job_id)).toEqual(original);
    const retry = await refresh(annual.job_id);
    (await modelCall(app, "compensation.classification")).invalidJson();
    await terminal(api, retry.runId);
    const recovered = await posted(annual.job_id);
    expect(recovered).toMatchObject({ recordStatus: "recorded", sourceCurrent: true,
      fact: { sourceField: "salary", minimumAmount: 55000, maximumAmount: 55000, annualizedMinimumAmount: 55000, currency: "EUR", period: "year" } });
    expect(recovered.determination.created_at <= beforeUpgrade).toBe(true);
    expect(postedCalls()).toBe(before);
    await page.goto("/jobs?grid=v1&posted_known=source_known");
    await expect(page.getByRole("row").filter({ hasText: "Synthetic posted salary" })).toContainText("EUR 55000/year");
  });
});

test("Jobs validates complete period-grouped title tokens and keeps uncertain numbers unpriced", async ({ api, app, page }) => {
  const settings = await json<{ revision: number }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", { expectedRevision: settings.revision, dailyBudgetUsd: 0 });
  const assess = async (slug: string, field: "title" | "salary", text: string, quote: string, low: number | null, high: number | null, valid: boolean) => {
    const job = await json<{ job_id: string }>(api, "post", "/v1/jobs/capture", {
      url: `https://example.com/jobs/${slug}`, title: "Synthetic salary role", [field]: text, company: "Synthetic Employer",
    });
    const run = await action(api, "compensation.refresh", { jobId: job.job_id, includeEuroTopTech: false });
    await replyToPay(app, field, text, quote, low, high);
    if (valid) (await modelCall(app, "compensation.classification")).invalidJson();
    expect((await terminal(api, run.runId)).status).toBe("failed");
    const posted = await json(api, "get", `/v1/jobs/${job.job_id}/compensation/posted`);
    expect(posted).toMatchObject(valid ? { recordStatus: "recorded", fact: low === null ? { parseState: "ambiguous" } : {
      sourceField: field, minimumAmount: low, maximumAmount: high, period: "unknown", component: "unknown", annualizedMinimumAmount: null,
    } } : { recordStatus: "not_recorded" });
    return job.job_id;
  };
  const title = "Synthetic range | €950.000 to €1.234.567";
  await assess("repeated-groups", "title", title, "€950.000 to €1.234.567", 950000, 1234567, true);
  await assess("trailing-zero-cents", "salary", "EUR 55.000,00", "55.000,00", 55000, 55000, true);
  await assess("decimal-ambiguity", "salary", "EUR 55.000", "55.000", null, null, true);
  await assess("one-token-two-values", "salary", "EUR 55.000", "55.000", 55, 55000, false);
  await assess("fractional-cents", "salary", "EUR 55.000,50", "55.000,50", 55000, 55000, false);
  await assess("clipped-token", "salary", "Budget 55.0000 and another amount 55.000 euros.", "Budget 55.000", 55000, 55000, false);
  await assess("invalid-triple", "salary", "EUR 5.50.000", "5.50.000", 550000, 550000, false);
  await assess("decimal-without-group", "salary", "EUR 0.500", "0.500", 500, 500, false);
  await page.goto("/jobs?grid=v1&posted_known=source_known");
  await expect(page.getByRole("table", { name: "Jobs table", exact: true }).locator("tbody tr")).toHaveCount(2);
});

test("a title with only a repeated period-grouped number reaches automatic pay assessment", async ({ api, app }) => {
  const settings = await json<{ revision: number }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", { expectedRevision: settings.revision, dailyBudgetUsd: 0, compensationAutomationEnabled: true });
  const title = "Synthetic senior role | €1.234.567";
  const job = await json<{ job_id: string }>(api, "post", "/v1/jobs/capture", { url: "https://example.com/jobs/repeated-title", title });
  await replyToPay(app, "title", title, "€1.234.567", 1234567, 1234567);
  (await modelCall(app, "compensation.classification")).invalidJson();
  expect(await json(api, "get", `/v1/jobs/${job.job_id}/compensation/posted`)).toMatchObject({ sourceCurrent: true,
    fact: { sourceField: "title", minimumAmount: 1234567, maximumAmount: 1234567, period: "unknown", component: "unknown" } });
});
