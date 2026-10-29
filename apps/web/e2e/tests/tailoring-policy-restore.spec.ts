import { expect, test } from "@playwright/test";
import path from "node:path";
import Database from "better-sqlite3";

import { loadE2eDbPath } from "../fixtures/e2e-state.js";

// Only the reviewed policy command reaches the real worker; every other
// provider, browser capability and external operation stays unavailable.
test.skip(process.env["JOBCTRL_E2E_POLICY_RPC"] !== "1", "Requires the isolated policy RPC fixture.");

test("reviewed restore refuses a stale review and replays its receipt after later change", async ({ page }) => {
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  const dbPath = loadE2eDbPath();
  appendIndependentRevision(dbPath, 2);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page).toHaveTitle("JobCtrl");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  const history = page.locator(".tailoring-policy-history-panel");
  await expect(history.getByRole("article", { name: "Version 2" })).toBeVisible({ timeout: 60_000 });
  await history.getByRole("button", { name: "Restore version 1 of tailoring policy" }).click();
  await expect(history.getByText(/current version 2 → configuration from version 1/i)).toBeVisible();

  // The independent writer commits after the review was opened.
  appendIndependentRevision(dbPath, 3);
  const staleResponse = page.waitForResponse((response) =>
    response.url().includes("/v1/learning/policies/materials/rollbacks") && response.request().method() === "POST");
  await history.getByRole("button", { name: "Confirm restore" }).click();
  expect((await staleResponse).status()).toBe(409);
  await expect(history.getByText("Policy changed since review")).toBeVisible();
  await expect(history.getByRole("article", { name: "Version 3" })).toBeVisible();
  expect(versions(dbPath)).toEqual([1, 2, 3]);

  await history.getByRole("button", { name: "Restore version 1 of tailoring policy" }).click();
  await expect(history.getByText(/current version 3 → configuration from version 1/i)).toBeVisible();
  if (process.env["JOBCTRL_E2E_POLICY_SCREENSHOTS"]) {
    await history.screenshot({ path: path.join(process.env["JOBCTRL_E2E_POLICY_SCREENSHOTS"], "restore-review.png") });
  }
  const acceptedResponse = page.waitForResponse((response) =>
    response.url().includes("/v1/learning/policies/materials/rollbacks") && response.request().method() === "POST");
  await history.getByRole("button", { name: "Confirm restore" }).click();
  const accepted = await acceptedResponse;
  expect(accepted.status()).toBe(200);
  const command = accepted.request().postDataJSON();
  expect(command).toMatchObject({ targetVersion: 1, expectedCurrentVersion: 3, reasonCode: "user_requested" });
  expect(await accepted.json()).toMatchObject({ version: 4, currentVersion: 4, status: "current", replayed: false });
  await expect(history.getByRole("article", { name: "Version 4" })).toContainText("Reviewed current version 3");
  expect(versions(dbPath)).toEqual([1, 2, 3, 4]);

  appendIndependentRevision(dbPath, 5);
  const replay = await page.evaluate(async (body) => {
    const response = await fetch("/v1/learning/policies/materials/rollbacks", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }, command);
  expect(replay.status).toBe(200);
  expect(replay.body).toMatchObject({ version: 4, currentVersion: 5, status: "superseded", replayed: true });
  expect(versions(dbPath)).toEqual([1, 2, 3, 4, 5]);
  await page.reload();
  await expect(history.getByRole("article", { name: "Version 5" })).toContainText("Current");
  await expect(history.getByRole("article", { name: "Version 4" })).toContainText("Superseded");
  if (process.env["JOBCTRL_E2E_POLICY_SCREENSHOTS"]) {
    await history.screenshot({ path: path.join(process.env["JOBCTRL_E2E_POLICY_SCREENSHOTS"], "restore-history.png") });
  }
  // Chromium logs the deliberately exercised 409; no other browser errors are expected.
  const staleConflictLogs = consoleErrors.filter((message) => message.includes("status of 409 (Conflict)"));
  expect(staleConflictLogs.length).toBeLessThanOrEqual(1);
  expect(consoleErrors.filter((message) => !staleConflictLogs.includes(message))).toEqual([]);
});

function appendIndependentRevision(path: string, version: number): void {
  const db = new Database(path);
  try {
    const result = db.prepare(`INSERT INTO tailoring_policies
      (tenant_id, version, prompt_version, schema_version, judge_schema_version,
       prompt_fingerprint, config_fingerprint, profile_policy_fingerprint, custom_prompt_fingerprint,
       generator_settings_json, judge_settings_json, runtime_settings_json,
       rollback_of_version, rollback_reason, created_at, created_from_event_id)
      SELECT tenant_id, ?, prompt_version, schema_version, judge_schema_version,
       prompt_fingerprint, config_fingerprint, profile_policy_fingerprint, custom_prompt_fingerprint,
       generator_settings_json, judge_settings_json, runtime_settings_json,
       NULL, '', '2026-08-02T12:00:00Z', NULL
      FROM tailoring_policies WHERE tenant_id='local' AND version=1`).run(version);
    expect(result.changes).toBe(1);
  } finally { db.close(); }
}

function versions(path: string): number[] {
  const db = new Database(path, { readonly: true });
  try { return (db.prepare("SELECT version FROM tailoring_policies WHERE tenant_id='local' ORDER BY version").all() as Array<{ version: number }>).map((row) => row.version); }
  finally { db.close(); }
}
