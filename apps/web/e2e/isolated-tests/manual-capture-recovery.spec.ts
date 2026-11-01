import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { sampleHealthResponse } from "../../src/test/fixtures/projections.js";
import { loadE2eDbPath } from "../fixtures/e2e-state.js";

const itemId = "qa-manual-capture-1285";
const url = "https://example.test/jobs/recovery-1285";
const original = "<main>Synthetic captured page needing review</main>";
const corrected = "<main>Synthetic corrected posting</main>";
const retried = "<main>Synthetic posting reviewed for retry</main>";
const staleWorkerMessage = "Synthetic worker heartbeat is stale.";

function draft(content: string, token: string) {
  return { manual_capture_draft: { token, capture_mode: "saved_html", captured_url: url,
    content, note: "Synthetic retry", future_manual_action_required: true } };
}

test.afterEach(() => {
  const db = new Database(loadE2eDbPath());
  try { db.prepare("DELETE FROM manual_capture_queue WHERE tenant_id='local' AND item_id=?").run(itemId); }
  finally { db.close(); }
});

test("manual capture recovery advances the review lifecycle and retries the reviewed draft", async ({ page }) => {
  await page.route("**/v1/health", async (route) => {
    await route.fulfill({ json: {
      ...sampleHealthResponse,
      worker: { ...sampleHealthResponse.worker, status: "stale", message: staleWorkerMessage },
    } });
  });
  const db = new Database(loadE2eDbPath());
  try {
    db.prepare(`INSERT INTO manual_capture_queue
      (tenant_id,item_id,originating_url,source_id,reason,retry_context_json,required_at,status)
      VALUES ('local',?,?,'manual:qa','login_required',?,'2026-10-28','pending')`)
      .run(itemId, url, JSON.stringify(draft(original, "first")));
  } finally { db.close(); }
  // The shared browser fixture has no Temporal worker. Only the import outcome
  // is simulated; queue reads, preparation and supersede use the real local API.
  const submissions: Array<{ content: string; lifecycleId: string }> = [];
  await page.route(`**/v1/discovery/manual-capture/${itemId}/import`, async (route) => {
    const body = route.request().postDataJSON() as { contentHtmlBase64: string; expectedLifecycleId: string };
    const submitted = Buffer.from(body.contentHtmlBase64, "base64").toString("utf8");
    submissions.push({ content: submitted, lifecycleId: body.expectedLifecycleId });
    const writer = new Database(loadE2eDbPath());
    try { writer.prepare("UPDATE manual_capture_queue SET retry_context_json=json_set(retry_context_json, '$.manual_capture_draft', json(?)) WHERE tenant_id='local' AND item_id=?")
      .run(JSON.stringify(draft(submitted, `attempt-${submissions.length}`).manual_capture_draft), itemId); }
    finally { writer.close(); }
    await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({
      ok: false, error: "manual_capture_import_failed", message: "Review the retained capture and try again.",
    }) });
  });
  const initialQueue = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/v1/discovery/manual-capture"
    && response.request().method() === "GET");
  await page.goto("/discovery");
  await page.getByRole("tab", { name: "Manual capture" }).click();
  await expect(page.getByLabel("Saved HTML")).toHaveValue(original);
  const queueResponse = await initialQueue;
  expect(queueResponse.status()).toBe(200);
  const queue = await queueResponse.json() as { items: Array<{ itemId: string; lifecycleId: string }> };
  const initialLifecycle = queue.items.find((item) => item.itemId === itemId)?.lifecycleId;
  expect(initialLifecycle).toMatch(/^[a-f0-9]{64}$/);
  await page.getByLabel("Saved HTML").fill(corrected);
  const initialPreparation = page.waitForResponse((response) =>
    response.url().endsWith(`/v1/discovery/manual-capture/${itemId}/prepare`)
    && response.request().method() === "POST");
  const initialImport = page.waitForResponse((response) =>
    response.url().endsWith(`/v1/discovery/manual-capture/${itemId}/import`)
    && response.request().method() === "POST");
  await page.getByRole("button", { name: `Import ${url}` }).click();
  const prepared = await initialPreparation;
  expect(prepared.status()).toBe(200);
  const initialPrepareBody = prepared.request().postDataJSON() as { expectedLifecycleId: string };
  expect(initialPrepareBody.expectedLifecycleId).toBe(initialLifecycle);
  const initialPrepared = await prepared.json() as { ok: boolean; itemId: string; lifecycleId: string };
  expect(initialPrepared).toEqual({ ok: true, itemId, lifecycleId: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(initialPrepared.lifecycleId).not.toBe(initialLifecycle);
  const firstImport = await initialImport;
  expect(firstImport.status()).toBe(422);
  expect(firstImport.request().postDataJSON()).toEqual({ ...initialPrepareBody, expectedLifecycleId: initialPrepared.lifecycleId });
  await expect(page.getByRole("alert").filter({ hasText: staleWorkerMessage })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Review the retained capture" }))
    .toContainText("Review the retained capture");
  await expect(page.getByLabel("Saved HTML")).toHaveValue(corrected);
  await expect(page.getByLabel("Saved HTML")).toBeDisabled();
  await expect(page.getByText("Prevent earlier imports for this capture from saving before you review and retry.")).toBeVisible();
  const recovery = page.waitForResponse((response) => response.url().endsWith(`/v1/discovery/manual-capture/${itemId}/supersede`)
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Prevent earlier imports from saving" }).click();
  const recovered = await recovery;
  expect(recovered.status()).toBe(200);
  const { lifecycleId } = await recovered.json() as { lifecycleId: string };
  expect(lifecycleId).toMatch(/^[a-f0-9]{64}$/);
  expect(lifecycleId).not.toBe(initialPrepared.lifecycleId);
  const recoveredDb = new Database(loadE2eDbPath());
  try {
    const row = recoveredDb.prepare("SELECT retry_context_json FROM manual_capture_queue WHERE tenant_id='local' AND item_id=?").get(itemId) as { retry_context_json: string };
    const context = JSON.parse(row.retry_context_json) as { manual_capture_generation: string; manual_capture_draft: { token: string; content: string } };
    expect(context.manual_capture_generation).toMatch(/^[a-f0-9]{32}$/);
    expect(context.manual_capture_draft).toMatchObject({ content: corrected });
    expect(context.manual_capture_draft.token).not.toBe("attempt-1");
  } finally { recoveredDb.close(); }
  await expect(page.getByLabel("Saved HTML")).toBeEnabled();
  await expect(page.getByLabel("Saved HTML")).toHaveValue(corrected);
  await page.getByLabel("Saved HTML").fill(retried);
  const retryPreparation = page.waitForResponse((response) =>
    response.url().endsWith(`/v1/discovery/manual-capture/${itemId}/prepare`)
    && response.request().method() === "POST");
  const retryResponse = page.waitForResponse((response) => response.url().endsWith(`/v1/discovery/manual-capture/${itemId}/import`)
    && response.request().method() === "POST");
  await page.getByRole("button", { name: `Import ${url}` }).click();
  const retryPreparedResponse = await retryPreparation;
  expect(retryPreparedResponse.status()).toBe(200);
  const retryPrepareBody = retryPreparedResponse.request().postDataJSON() as { expectedLifecycleId: string };
  expect(retryPrepareBody.expectedLifecycleId).toBe(lifecycleId);
  const retryPrepared = await retryPreparedResponse.json() as { ok: boolean; itemId: string; lifecycleId: string };
  expect(retryPrepared).toEqual({ ok: true, itemId, lifecycleId: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(retryPrepared.lifecycleId).not.toBe(lifecycleId);
  const retryImport = await retryResponse;
  expect(retryImport.status()).toBe(422);
  expect(retryImport.request().postDataJSON()).toEqual({ ...retryPrepareBody, expectedLifecycleId: retryPrepared.lifecycleId });
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions).toEqual([
    { content: corrected, lifecycleId: initialPrepared.lifecycleId },
    { content: retried, lifecycleId: retryPrepared.lifecycleId },
  ]);
  await expect(page.getByLabel("Saved HTML")).toBeDisabled();
  await page.reload();
  await page.getByRole("tab", { name: "Manual capture" }).click();
  await expect(page.getByLabel("Saved HTML")).toHaveValue(retried);
  await expect(page.getByLabel("Saved HTML")).toBeDisabled();
  await expect(page.getByText("An earlier import may still finish. Review the retained capture before retrying.")).toBeVisible();
  const check = new Database(loadE2eDbPath());
  try { expect(check.prepare("SELECT status FROM manual_capture_queue WHERE tenant_id='local' AND item_id=?").get(itemId))
    .toEqual({ status: "pending" }); }
  finally { check.close(); }
});
