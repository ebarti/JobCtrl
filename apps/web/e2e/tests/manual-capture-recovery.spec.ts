import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { sampleHealthResponse } from "../../src/test/fixtures/projections.js";
import { loadE2eDbPath } from "../fixtures/e2e-state.js";

const itemId = "qa-manual-capture-1285";
const url = "https://example.test/jobs/recovery-1285";
const original = "<main>Synthetic captured page needing review</main>";
const corrected = "<main>Synthetic corrected posting</main>";
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

test("manual capture failure remains visible and its edited draft survives reload", async ({ page }) => {
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
  await page.route(`**/v1/discovery/manual-capture/${itemId}/import`, async (route) => {
    const body = route.request().postDataJSON() as { contentHtmlBase64: string };
    const submitted = Buffer.from(body.contentHtmlBase64, "base64").toString("utf8");
    const writer = new Database(loadE2eDbPath());
    try { writer.prepare("UPDATE manual_capture_queue SET retry_context_json=? WHERE tenant_id='local' AND item_id=?")
      .run(JSON.stringify(draft(submitted, "second")), itemId); }
    finally { writer.close(); }
    await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({
      ok: false, error: "manual_capture_import_failed", message: "Review the retained capture and try again.",
    }) });
  });
  await page.goto("/discovery");
  await page.getByRole("tab", { name: "Manual capture" }).click();
  await expect(page.getByLabel("Saved HTML")).toHaveValue(original);
  await page.getByLabel("Saved HTML").fill(corrected);
  await page.getByRole("button", { name: `Import ${url}` }).click();
  await expect(page.getByRole("alert").filter({ hasText: staleWorkerMessage })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Review the retained capture" }))
    .toContainText("Review the retained capture");
  await expect(page.getByLabel("Saved HTML")).toHaveValue(corrected);
  await page.reload();
  await page.getByRole("tab", { name: "Manual capture" }).click();
  await expect(page.getByLabel("Saved HTML")).toHaveValue(corrected);
  const check = new Database(loadE2eDbPath());
  try { expect(check.prepare("SELECT status FROM manual_capture_queue WHERE tenant_id='local' AND item_id=?").get(itemId))
    .toEqual({ status: "pending" }); }
  finally { check.close(); }
});
