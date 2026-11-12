import { test, expect, json, action, completed, terminal, modelCall, type ExternalCall } from "../harness/fixtures.js";
import { baseline, createBaseline } from "./core-data.js";

type Spend = {
  costUsd: number | null; knownCostUsd: number; costStatus: string; tokenStatus: string;
  accountingComplete: boolean; costAuthority: string; unlimited: boolean;
  accountingBlocked: boolean; monetaryAccountingBlocked: boolean; tokenAccountingBlockedLanes: string[];
  activeCalls: number; unresolvedCalls: number; unavailableCostCalls: number; unavailableTokenCalls: number;
};
function plan(call: ExternalCall) {
  const source = (call.body["sources"] as { source_id: string; text: string }[]).find((row) => row.source_id === "target:functions")!;
  expect(source).toBeTruthy();
  return { queries: [{ query: "Synthetic reliability operations", tier: 2, source_scope: [],
    citations: [{ source_id: source.source_id, quote: source.text }], rationale: "The authored synthetic function supports this complementary query." }],
    rationale: "Retain the literal role and this explicitly supported function query." };
}
async function profileForPlanning(api: Parameters<typeof createBaseline>[0]) {
  return (await createBaseline(api, { ...baseline, experience: {
    target_role: "Synthetic Reliability Engineer", target_functions: "Synthetic reliability operations",
    target_locations: "Madrid", target_work_models: "remote",
  } })).profile;
}
async function settings(api: Parameters<typeof createBaseline>[0], patch: Record<string, unknown>) {
  const saved = await json<{ revision: number }>(api, "get", "/v1/settings");
  return json(api, "patch", "/v1/settings", { expectedRevision: saved.revision, ...patch });
}
const spend = async (api: Parameters<typeof createBaseline>[0]) => (await json<{ llmSpend: Spend }>(api, "get", "/v1/health")).llmSpend;

test("unlimited money accepts repeated settled token receipts without inventing spend or reconciliation and finite money still refuses", async ({ api, app, page }, testInfo) => {
  const profile = await profileForPlanning(api);
  await settings(api, { dailyBudgetUsd: 0 });
  let lastAccepted: unknown;
  for (let count = 1; count <= 2; count++) {
    const run = await action(api, "discovery.refresh_targets", { force: true, expectedProfileVersion: profile.profileVersion });
    const call = await modelCall(app, "discovery.query_plan");
    expect(await spend(api)).toMatchObject({ costStatus: "pending", tokenStatus: "pending", activeCalls: 1, unresolvedCalls: 0, costUsd: null, unlimited: true });
    await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === "/v1/digest" && response.request().method() === "GET" && response.ok()),
      page.goto("/jobs"),
    ]);
    await expect(page.locator(".connection-spend")).toHaveText("LLM running · No daily limit");
    await expect(page.getByText("Model call needs reconciliation", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Spending needs reconciliation", { exact: true })).toHaveCount(0);
    call.respond({ value: plan(call), usage: { input_tokens: 20, output_tokens: 10 } });
    await completed(api, run.runId);
    expect(await spend(api)).toMatchObject({ costStatus: "unavailable", tokenStatus: "complete", costUsd: null, knownCostUsd: 0,
      accountingComplete: false, costAuthority: "incomplete", activeCalls: 0, unresolvedCalls: 0,
      unavailableCostCalls: count, unavailableTokenCalls: 0, unlimited: true });
    const saved = await json<{ accepted: { provenance: { receipt_id: string } } }>(api, "get", "/v1/discovery/target-search");
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
  const refused = await action(api, "discovery.refresh_targets", { force: true, expectedProfileVersion: profile.profileVersion });
  expect(await terminal(api, refused.runId)).toMatchObject({ status: "failed", errorCode: "spend_accounting_unresolved" });
  expect(app.external.calls).toHaveLength(calls);
  expect(await json(api, "get", "/v1/discovery/target-search")).toEqual(lastAccepted);
  expect((await json<{ budget: Record<string, unknown> }>(api, "get", "/v1/digest")).budget).toMatchObject({ status: "incomplete", unlimited: false, costStatus: "unavailable", estimatedUsd: null });
  await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === "/v1/digest" && response.request().method() === "GET" && response.ok()),
      page.goto("/jobs"),
    ]);
  await expect(page.getByRole("link", { name: "Daily limit needs cost tracking", exact: true })).toBeVisible();
});

test("settled monetary receipts remain complete when token counts are unavailable and a finite token lane still refuses", async ({ api, app, page }) => {
  const profile = await profileForPlanning(api);
  const run = await action(api, "discovery.refresh_targets", { force: true, expectedProfileVersion: profile.profileVersion });
  const call = await modelCall(app, "discovery.query_plan");
  call.respond({ value: plan(call), usage: { cost_usd: 0.25, cost_source: "provider_reported" } });
  await completed(api, run.runId);
  const accepted = await json(api, "get", "/v1/discovery/target-search");
  expect(await spend(api)).toMatchObject({ costStatus: "complete", tokenStatus: "unavailable", costUsd: 0.25, knownCostUsd: 0.25,
    costAuthority: "reported", accountingComplete: false, activeCalls: 0, unresolvedCalls: 0, unavailableCostCalls: 0, unavailableTokenCalls: 1 });
  expect((await json<{ budget: Record<string, unknown> }>(api, "get", "/v1/digest")).budget).toMatchObject({ status: "ok", estimatedUsd: 0.25, remainingUsd: 24.75, costStatus: "complete", tokenStatus: "unavailable" });
  await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === "/v1/digest" && response.request().method() === "GET" && response.ok()),
      page.goto("/jobs"),
    ]);
  await expect(page.locator(".connection-spend")).toHaveText("LLM $0.25");
  await expect(page.getByText("Model call needs reconciliation", { exact: true })).toHaveCount(0);
  await settings(api, { dailyBudgetUsd: 0, laneTokenLimits: { enrichment: 1000 } });
  const calls = app.external.calls.length;
  const refused = await action(api, "discovery.refresh_targets", { force: true, expectedProfileVersion: profile.profileVersion });
  expect(await terminal(api, refused.runId)).toMatchObject({ status: "failed", errorCode: "spend_accounting_unresolved" });
  expect(app.external.calls).toHaveLength(calls);
  expect(await json(api, "get", "/v1/discovery/target-search")).toEqual(accepted);
});


test("unknown usage after public cancellation is informational without caps while finite money and affected token lanes still refuse", async ({ api, app, page }, testInfo) => {
  const profile = await profileForPlanning(api);
  await settings(api, { dailyBudgetUsd: 0 });
  const cancelled = await action(api, "discovery.refresh_targets", { force: true, expectedProfileVersion: profile.profileVersion });
  const held = await modelCall(app, "discovery.query_plan");
  await json(api, "post", `/v1/action-runs/${cancelled.runId}/cancel`, {});
  expect(await terminal(api, cancelled.runId)).toMatchObject({ status: "cancelled", cancellationRequested: true });
  await expect.poll(() => held.closed).toBe(true);
  expect(await spend(api)).toMatchObject({ costStatus: "unresolved", tokenStatus: "unresolved", unresolvedCalls: 1,
    costUsd: null, accountingComplete: false, accountingBlocked: false, monetaryAccountingBlocked: false, tokenAccountingBlockedLanes: [] });
  expect((await json<{ budget: Record<string, unknown> }>(api, "get", "/v1/digest")).budget).toMatchObject({ status: "ok", costStatus: "unresolved", estimatedUsd: null, accountingBlocked: false });
  // A finite unrelated lane is not a global blocker for the enrichment receipt.
  await settings(api, { laneTokenLimits: { scoring: 1000 } });
  expect((await spend(api)).tokenAccountingBlockedLanes).toEqual([]);
  const fresh = await action(api, "discovery.refresh_targets", { force: true, expectedProfileVersion: profile.profileVersion });
  const next = await modelCall(app, "discovery.query_plan");
  expect(await spend(api)).toMatchObject({ activeCalls: 1, unresolvedCalls: 1, costStatus: "unresolved", accountingBlocked: false });
  await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === "/v1/digest" && response.ok()),
    page.goto("/jobs"),
  ]);
  await expect(page.locator(".connection-spend")).toHaveText("LLM running · No daily limit");
  await expect(page.getByRole("heading", { name: "Needs attention", exact: true })).toHaveCount(0);
  next.respond({ value: plan(next), usage: { input_tokens: 20, output_tokens: 10 } });
  await completed(api, fresh.runId);
  const accepted = await json(api, "get", "/v1/discovery/target-search");
  await page.goto("/settings/budgets");
  await page.getByText("Today's model usage", { exact: true }).click();
  await expect(page.getByText("1 past model call has unknown final usage. The original receipts remain unchanged.", { exact: true })).toBeVisible();
  await expect(page.getByText("No enabled accounting limit is blocked by this history. New work can continue under the saved policies.", { exact: true })).toBeVisible();
  await expect(page.locator(".connection-spend")).toHaveText("LLM · No daily limit");
  await testInfo.attach("unknown-usage-informational", { contentType: "image/png", body: await page.screenshot({ animations: "disabled" }) });
  const calls = app.external.calls.length;
  for (const policy of [
    { dailyBudgetUsd: 25, laneTokenLimits: {}, monetaryAccountingBlocked: true, tokenAccountingBlockedLanes: [], label: "Daily limit needs cost tracking" },
    { dailyBudgetUsd: 0, laneTokenLimits: { enrichment: 1000 }, monetaryAccountingBlocked: false, tokenAccountingBlockedLanes: ["enrichment"], label: "Token limit needs usage tracking" },
  ]) {
    await settings(api, { dailyBudgetUsd: policy.dailyBudgetUsd, laneTokenLimits: policy.laneTokenLimits });
    const refused = await action(api, "discovery.refresh_targets", { force: true, expectedProfileVersion: profile.profileVersion });
    expect(await terminal(api, refused.runId)).toMatchObject({ status: "failed", errorCode: "spend_accounting_unresolved" });
    expect(app.external.calls).toHaveLength(calls);
    expect(await json(api, "get", "/v1/discovery/target-search")).toEqual(accepted);
    expect(await spend(api)).toMatchObject({ unresolvedCalls: 1, costUsd: null, accountingBlocked: true,
      monetaryAccountingBlocked: policy.monetaryAccountingBlocked, tokenAccountingBlockedLanes: policy.tokenAccountingBlockedLanes });
    await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === "/v1/digest" && response.ok()),
      page.goto("/jobs"),
    ]);
    await expect(page.getByRole("link", { name: policy.label, exact: true })).toBeVisible();
  }
});
