import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

interface State {
  workspace?: { dbPath?: string };
}

function findRepoRoot(start: string): string {
  let current = path.resolve(start);
  for (let i = 0; i < 10; i += 1) {
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const next = path.dirname(current);
    if (next === current) {
      throw new Error(`Could not find repo root above ${start}`);
    }
    current = next;
  }
  throw new Error(`Could not find repo root within 10 ancestors of ${start}`);
}

function loadDbPath(): string {
  const stateFile = path.join(findRepoRoot(process.cwd()), ".jobctrl-e2e-state.json");
  const raw = fs.readFileSync(stateFile, "utf-8");
  const state = JSON.parse(raw) as State;
  if (!state.workspace?.dbPath) {
    throw new Error("E2E state file is missing workspace.dbPath; global-setup did not run.");
  }
  return state.workspace.dbPath;
}

test("Dry-run apply: seed JobScored event → activity feed reflects new event", async ({
  page,
}) => {
  const dbPath = loadDbPath();

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
