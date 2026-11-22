import { test, expect, json, action, terminal } from "../harness/fixtures.js";
import { baseline, createBaseline } from "./core-data.js";

test.use({ nativeAccountingPreflight: true, features: "profile,jobs,discovery" });

test("native Discovery preflight explains missing accounting and Start search opens contextual pricing setup without spending", async ({ api, app, page }, testInfo) => {
  // Ordinary native gateway, no model boundary replacement. The missing quote
  // must refuse before a native provider/credential call. Never launch a model
  // after saving the deliberately synthetic quote used to test the editor.
  const forbiddenRequests: string[] = [];
  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith("/v1/credentials") || pathname.startsWith("/v1/providers") || pathname === "/v1/setup/status") {
      forbiddenRequests.push(pathname);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  const { profile } = await createBaseline(api, { ...baseline, experience: {
    target_role: "Synthetic Reliability Engineer", target_functions: "Synthetic systems reliability",
    target_locations: "Madrid", target_work_models: "remote",
  } });
  const searchSettings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", {
    expectedRevision: searchSettings.revision, boards: ["indeed"], hoursOld: 24, newJobLimit: 1, resultsPerSite: 1,
  });
  type Settings = { revision: number; defaultProvider: string; providerModels: Record<string, string>; dailyBudgetUsd: number; modelPricingQuotes: Record<string, unknown>; modelAccounting: { provider: string; model: string; available: boolean; costSource: string | null } };
  const initial = await json<Settings>(api, "get", "/v1/settings");
  expect(initial.modelAccounting).toMatchObject({ provider: "codex", model: "gpt-6", available: false, costSource: null });
  expect(initial.dailyBudgetUsd).toBe(25);
  const failed = await action(api, "discovery.search", { queries: [], locations: [], expectedProfileVersion: profile.profileVersion });
  expect(await terminal(api, failed.runId)).toMatchObject({ status: "failed", errorCode: "cost_accounting_unavailable" });
  expect((await json<{ runs: unknown[] }>(api, "get", "/v1/discovery/runs")).runs).toEqual([]);
  await page.goto("/jobs?q=synthetic");
  await expect(page.getByRole("heading", { name: "Search stopped for missing cost tracking", exact: true })).toBeVisible();
  await expect(page.getByText("Job sources were not searched.", { exact: false })).toBeVisible();
  const originalSearch = new URL(page.url()).search;
  const start = page.getByRole("button", { name: "Start search", exact: true });
  await expect(start).toBeEnabled();
  await start.click();
  const dialog = page.getByRole("dialog", { name: "Set up search cost tracking" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("codex:gpt-6");
  await expect(dialog).toContainText("$25 daily budget");
  await testInfo.attach("actionable-accounting-setup", { contentType: "image/png", body: await page.screenshot({ animations: "disabled" }) });
  await dialog.getByRole("link", { name: "Review spending setup" }).click();
  await expect(page.getByRole("heading", { name: "Budgets and pricing", exact: true })).toBeVisible();
  const quote = { "codex:gpt-6": { inputUsdPerMillion: 1, outputUsdPerMillion: 2, source: "Owned synthetic QA quote; not provider pricing", revision: "synthetic-accounting-journey-v1" } };
  await page.getByRole("textbox", { name: "Model pricing quotes", exact: true }).fill(JSON.stringify(quote));
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect.poll(async () => (await json<Settings>(api, "get", "/v1/settings")).modelAccounting.available).toBe(true);
  const saved = await json<Settings>(api, "get", "/v1/settings");
  expect(saved).toMatchObject({ defaultProvider: initial.defaultProvider, providerModels: initial.providerModels,
    dailyBudgetUsd: initial.dailyBudgetUsd, modelPricingQuotes: quote, modelAccounting: { costSource: "configured_pricing_estimate" } });
  await page.getByRole("link", { name: "Back to jobs", exact: false }).click();
  await expect.poll(() => new URL(page.url()).search).toBe(originalSearch);
  await expect(start).toBeEnabled();
  // Historical refusal stays truthful; saving never silently retries the action.
  expect((await json<{ runs: { runId: string }[] }>(api, "get", "/v1/action-runs?action=discovery.search")).runs.map((run) => run.runId)).toEqual([failed.runId]);
  expect(await json(api, "get", "/v1/profile")).toEqual(profile);
  expect(forbiddenRequests).toEqual([]);
  expect(app.external.calls).toEqual([]);
  await testInfo.attach("pricing-saved-and-returned", { contentType: "image/png", body: await page.screenshot({ animations: "disabled" }) });
});
