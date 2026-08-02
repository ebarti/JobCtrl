import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";

import { loadE2eDbPath, QA_PLATFORM_JOB_ID } from "../fixtures/e2e-state.js";

test("Dry-run apply: seed JobScored event → activity feed reflects new event", async ({
  page,
}) => {
  const dbPath = loadE2eDbPath();

  await page.goto("/debug");
  const livePill = page.locator(".connection-pill");
  await expect(livePill).toContainText("Live", { timeout: 30_000 });
  const activityRows = page.locator("table.activity-data-grid-table tbody tr");
  await expect(activityRows.first()).toBeVisible({ timeout: 30_000 });

  const occurredAt = new Date().toISOString();
  const eventMessage = `QA E2E injected JobScored event ${Date.now()}`;
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO job_events (
         tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json
       ) VALUES ('local', ?, 1, ?, ?, ?, ?, ?, ?)`,
    ).run(
      QA_PLATFORM_JOB_ID,
      "score",
      "JobScored",
      "info",
      eventMessage,
      occurredAt,
      JSON.stringify({
        tenantId: "local",
        jobId: QA_PLATFORM_JOB_ID,
        fitScore: 9,
        breakdown: {},
        keywords: ["platform"],
        version: 1,
        scoredAt: occurredAt,
      }),
    );
  } finally {
    db.close();
  }

  // This fixture writes behind the API rather than through a product command.
  // Reload to exercise the authoritative read path without making this
  // workflow regression depend on delivery timing already covered by the SSE
  // integration suite.
  await page.reload();
  await expect(
    page
      .locator("table.activity-data-grid-table tbody tr")
      .filter({ hasText: eventMessage }),
  ).toBeVisible({ timeout: 30_000 });
});
