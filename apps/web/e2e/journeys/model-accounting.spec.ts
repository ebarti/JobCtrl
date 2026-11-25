import { test, expect, json, action, completed, terminal, modelCall, type ExternalCall } from "../harness/fixtures.js";
import { baseline, createBaseline, createPosting, type Posting } from "./core-data.js";
import { citeSources, modelSources } from "./requirements-data.js";

type Spend = {
  costUsd: number | null; knownCostUsd: number; costStatus: string; tokenStatus: string;
  accountingComplete: boolean; costAuthority: string; unlimited: boolean;
  accountingBlocked: boolean; monetaryAccountingBlocked: boolean; tokenAccountingBlockedLanes: string[];
  activeCalls: number; dailyActiveCalls: number; unresolvedCalls: number; unavailableCostCalls: number; unavailableTokenCalls: number;
};
function assessment(call: ExternalCall) {
  const source = modelSources(call)[0]!;
  const citations = citeSources(call, [source.source_id]);
  const statement = { text: source.text, citations, uncertainty: "Only the supplied posting was considered." };
  return { role_framing: statement,
    inferred_seniority: { value: "unknown", citations, rationale: "The posting does not specify a level." },
    ideal_candidate_narrative: statement, keywords: [] };
}
async function postingForAnalysis(api: Parameters<typeof createBaseline>[0]) {
  await createBaseline(api, { ...baseline, experience: {
    target_role: "Synthetic Reliability Engineer", target_locations: "Madrid", target_work_models: "remote",
  } });
  return createPosting(api, "model-accounting");
}
const startAnalysis = (api: Parameters<typeof createBaseline>[0], posting: Posting) =>
  action(api, "jobs.analyze", { job_id: posting.job_id, expectedRevision: posting.revision, force: true });
const readAnalysis = (api: Parameters<typeof createBaseline>[0], posting: Posting) =>
  json<{ accepted: { provenance: { receipt_id: string } } }>(api, "get", `/v1/jobs/${posting.job_id}/analysis`);
async function expectRefusal(api: Parameters<typeof createBaseline>[0], posting: Posting, runId: string) {
  expect(await terminal(api, runId)).toMatchObject({ status: "failed", errorCode: "role_analysis_failed" });
  const history = await json<{ attempts: unknown[] }>(api, "get", `/v1/jobs/${posting.job_id}/snapshots`);
  expect(history.attempts).toContainEqual(expect.objectContaining({ failure_code: "role_analysis_failed",
    data: expect.objectContaining({ failures: [expect.objectContaining({ code: "spend_accounting_unresolved" })] }) }));
}
async function settings(api: Parameters<typeof createBaseline>[0], patch: Record<string, unknown>) {
  const saved = await json<{ revision: number }>(api, "get", "/v1/settings");
  return json(api, "patch", "/v1/settings", { expectedRevision: saved.revision, ...patch });
}
const spend = async (api: Parameters<typeof createBaseline>[0]) => (await json<{ llmSpend: Spend }>(api, "get", "/v1/health")).llmSpend;

test("unlimited money accepts repeated settled token receipts without inventing spend or reconciliation and finite money still refuses", async ({ api, app, page }, testInfo) => {
  const posting = await postingForAnalysis(api);
  await settings(api, { dailyBudgetUsd: 0 });
  let lastAccepted: unknown;
  for (let count = 1; count <= 2; count++) {
    const run = await startAnalysis(api, posting);
    const call = await modelCall(app, "jobs.role_analysis");
    expect(await spend(api)).toMatchObject({ costStatus: "pending", tokenStatus: "pending", activeCalls: 1, dailyActiveCalls: 1, unresolvedCalls: 0, costUsd: null, unlimited: true });
    await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === "/v1/digest" && response.request().method() === "GET" && response.ok()),
      page.goto("/jobs"),
    ]);
    await expect(page.locator(".connection-spend")).toHaveText("LLM running · No daily limit");
    await expect(page.getByText("Model call needs reconciliation", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Spending needs reconciliation", { exact: true })).toHaveCount(0);
    call.respond({ value: assessment(call), usage: { input_tokens: 20, output_tokens: 10 } });
    await completed(api, run.runId);
    expect(await spend(api)).toMatchObject({ costStatus: "unavailable", tokenStatus: "complete", costUsd: null, knownCostUsd: 0,
      accountingComplete: false, costAuthority: "incomplete", activeCalls: 0, dailyActiveCalls: 0, unresolvedCalls: 0,
      unavailableCostCalls: count, unavailableTokenCalls: 0, unlimited: true });
    const saved = await readAnalysis(api, posting);
    expect(saved.accepted.provenance.receipt_id).toBeTruthy();
    lastAccepted = saved;
    const digest = await json<{ budget: Record<string, unknown> }>(api, "get", "/v1/digest");
    expect(digest.budget).toMatchObject({ status: "ok", unlimited: true, estimatedUsd: null, knownUsd: 0, remainingUsd: null, costStatus: "unavailable", tokenStatus: "complete" });
    await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === "/v1/digest" && response.request().method() === "GET" && response.ok()),
      page.goto("/jobs"),
    ]);
    await expect(page.locator(".connection-spend")).toContainText("No daily limit");
    await expect(page.getByText("Spending needs reconciliation", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Model call needs reconciliation", { exact: true })).toHaveCount(0);
    await expect(page.getByText("LLM spend pending or unresolved", { exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: "Start search", exact: true })).toBeEnabled();
  await testInfo.attach("unlimited-settled-cost-unavailable", { contentType: "image/png", body: await page.screenshot({ animations: "disabled" }) });
  const calls = app.external.calls.length;
  await settings(api, { dailyBudgetUsd: 25 });
  const refused = await startAnalysis(api, posting);
  await expectRefusal(api, posting, refused.runId);
  expect(app.external.calls).toHaveLength(calls);
  expect(await readAnalysis(api, posting)).toEqual(lastAccepted);
  expect((await json<{ budget: Record<string, unknown> }>(api, "get", "/v1/digest")).budget).toMatchObject({ status: "incomplete", unlimited: false, costStatus: "unavailable", estimatedUsd: null });
  await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === "/v1/digest" && response.request().method() === "GET" && response.ok()),
      page.goto("/jobs"),
    ]);
  await expect(page.getByRole("link", { name: "Daily limit needs cost tracking", exact: true })).toBeVisible();
});

test("settled monetary receipts remain complete when token counts are unavailable and a finite token lane still refuses", async ({ api, app, page }) => {
  const posting = await postingForAnalysis(api);
  const run = await startAnalysis(api, posting);
  const call = await modelCall(app, "jobs.role_analysis");
  call.respond({ value: assessment(call), usage: { cost_usd: 0.25, cost_source: "provider_reported" } });
  await completed(api, run.runId);
  const accepted = await readAnalysis(api, posting);
  expect(await spend(api)).toMatchObject({ costStatus: "complete", tokenStatus: "unavailable", costUsd: 0.25, knownCostUsd: 0.25,
    costAuthority: "reported", accountingComplete: false, activeCalls: 0, unresolvedCalls: 0, unavailableCostCalls: 0, unavailableTokenCalls: 1 });
  expect((await json<{ budget: Record<string, unknown> }>(api, "get", "/v1/digest")).budget).toMatchObject({ status: "ok", estimatedUsd: 0.25, remainingUsd: 24.75, costStatus: "complete", tokenStatus: "unavailable" });
  await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === "/v1/digest" && response.request().method() === "GET" && response.ok()),
      page.goto("/jobs"),
    ]);
  await expect(page.locator(".connection-spend")).toHaveText("LLM $0.25");
  await expect(page.getByText("Model call needs reconciliation", { exact: true })).toHaveCount(0);
  await settings(api, { dailyBudgetUsd: 0, laneTokenLimits: { analysis: 1000 } });
  const calls = app.external.calls.length;
  const refused = await startAnalysis(api, posting);
  await expectRefusal(api, posting, refused.runId);
  expect(app.external.calls).toHaveLength(calls);
  expect(await readAnalysis(api, posting)).toEqual(accepted);
});


test("unknown usage after public cancellation is informational without caps while finite money and affected token lanes still refuse", async ({ api, app, page }, testInfo) => {
  const posting = await postingForAnalysis(api);
  await settings(api, { dailyBudgetUsd: 0 });
  const cancelled = await startAnalysis(api, posting);
  const held = await modelCall(app, "jobs.role_analysis");
  await json(api, "post", `/v1/action-runs/${cancelled.runId}/cancel`, {});
  expect(await terminal(api, cancelled.runId)).toMatchObject({ status: "cancelled", cancellationRequested: true });
  await expect.poll(() => held.closed).toBe(true);
  expect(await spend(api)).toMatchObject({ costStatus: "unresolved", tokenStatus: "unresolved", unresolvedCalls: 1,
    costUsd: null, accountingComplete: false, accountingBlocked: false, monetaryAccountingBlocked: false, tokenAccountingBlockedLanes: [] });
  expect((await json<{ budget: Record<string, unknown> }>(api, "get", "/v1/digest")).budget).toMatchObject({ status: "ok", costStatus: "unresolved", estimatedUsd: null, accountingBlocked: false });
  // A finite unrelated lane is not a global blocker for the analysis receipt.
  await settings(api, { laneTokenLimits: { scoring: 1000 } });
  expect((await spend(api)).tokenAccountingBlockedLanes).toEqual([]);
  const fresh = await startAnalysis(api, posting);
  const next = await modelCall(app, "jobs.role_analysis");
  expect(await spend(api)).toMatchObject({ activeCalls: 1, unresolvedCalls: 1, costStatus: "unresolved", accountingBlocked: false });
  await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === "/v1/digest" && response.ok()),
    page.goto("/jobs"),
  ]);
  await expect(page.locator(".connection-spend")).toHaveText("LLM running · No daily limit");
  await expect(page.getByRole("heading", { name: "Needs attention", exact: true })).toHaveCount(0);
  next.respond({ value: assessment(next), usage: { input_tokens: 20, output_tokens: 10 } });
  await completed(api, fresh.runId);
  const accepted = await readAnalysis(api, posting);
  await page.goto("/settings/budgets");
  await page.getByText("Today's model usage", { exact: true }).click();
  await expect(page.getByText("1 past model call has unknown final usage. The original receipts remain unchanged.", { exact: true })).toBeVisible();
  await expect(page.getByText("No enabled accounting limit is blocked by this history. New work can continue under the saved policies.", { exact: true })).toBeVisible();
  await expect(page.locator(".connection-spend")).toHaveText("LLM · No daily limit");
  await testInfo.attach("unknown-usage-informational", { contentType: "image/png", body: await page.screenshot({ animations: "disabled" }) });
  const calls = app.external.calls.length;
  for (const policy of [
    { dailyBudgetUsd: 25, laneTokenLimits: {}, monetaryAccountingBlocked: true, tokenAccountingBlockedLanes: [], label: "Daily limit needs cost tracking" },
    { dailyBudgetUsd: 0, laneTokenLimits: { analysis: 1000 }, monetaryAccountingBlocked: false, tokenAccountingBlockedLanes: ["analysis"], label: "Token limit needs usage tracking" },
  ]) {
    await settings(api, { dailyBudgetUsd: policy.dailyBudgetUsd, laneTokenLimits: policy.laneTokenLimits });
    const refused = await startAnalysis(api, posting);
    await expectRefusal(api, posting, refused.runId);
    expect(app.external.calls).toHaveLength(calls);
    expect(await readAnalysis(api, posting)).toEqual(accepted);
    expect(await spend(api)).toMatchObject({ unresolvedCalls: 1, costUsd: null, accountingBlocked: true,
      monetaryAccountingBlocked: policy.monetaryAccountingBlocked, tokenAccountingBlockedLanes: policy.tokenAccountingBlockedLanes });
    await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === "/v1/digest" && response.ok()),
      page.goto("/jobs"),
    ]);
    await expect(page.getByRole("link", { name: policy.label, exact: true })).toBeVisible();
  }
});
