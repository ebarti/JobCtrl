import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";

import { loadE2eDbPath } from "../fixtures/e2e-state.js";

test("Dry-run apply: seed JobScored event → activity feed reflects new event", async ({
  page,
}) => {
  const dbPath = loadE2eDbPath();

  await page.goto("/debug");
  const livePill = page.locator(".connection-pill");
  await expect(livePill).toBeVisible({ timeout: 30_000 });
  const activityRows = page.locator("table.activity-data-grid-table tbody tr");
  await expect(activityRows.first()).toBeVisible({ timeout: 30_000 });

  const occurredAt = new Date().toISOString();
  const eventMessage = `QA E2E injected JobScored event ${Date.now()}`;
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director",
      "score",
      "JobScored",
      "info",
      eventMessage,
      occurredAt,
      JSON.stringify({
        tenantId: "local",
        jobId: "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director",
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

  await expect(
    page.locator("table.activity-data-grid-table tbody tr").filter({ hasText: eventMessage }),
  ).toBeVisible({ timeout: 30_000 });
});
