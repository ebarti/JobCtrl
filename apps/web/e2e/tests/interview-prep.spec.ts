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
  const stateFile = path.join(findRepoRoot(process.cwd()), ".jobhunter-e2e-state.json");
  const raw = fs.readFileSync(stateFile, "utf-8");
  const state = JSON.parse(raw) as State;
  if (!state.workspace?.dbPath) {
    throw new Error("E2E state file is missing workspace.dbPath; global-setup did not run.");
  }
  return state.workspace.dbPath;
}

const JOB_URL = "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director";

function refreshWorkerHeartbeat(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.prepare("UPDATE worker_runtime_heartbeats SET last_seen_at = ?").run(new Date().toISOString());
  } finally {
    db.close();
  }
}

function seedAcceptedPrep(dbPath: string, occurredAt: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS job_interview_prep (
        job_url TEXT NOT NULL,
        generation INTEGER NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT 'local',
        status TEXT NOT NULL,
        model TEXT,
        generated_at TEXT NOT NULL,
        gate_status TEXT NOT NULL,
        fabrication_findings_json TEXT NOT NULL DEFAULT '[]',
        grounding_findings_json TEXT NOT NULL DEFAULT '[]',
        judge_verdict TEXT,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        failure_reason TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (job_url, generation)
      );
      CREATE TABLE IF NOT EXISTS job_interview_prep_items (
        job_url TEXT NOT NULL,
        generation INTEGER NOT NULL,
        item_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT 'local',
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        generated_text TEXT NOT NULL,
        evidence_ids_json TEXT NOT NULL DEFAULT '[]',
        requirement_ids_json TEXT NOT NULL DEFAULT '[]',
        source_text_json TEXT NOT NULL DEFAULT '[]',
        transform_type TEXT NOT NULL DEFAULT 'grounded_prep',
        control TEXT NOT NULL DEFAULT 'never_fabricate',
        grounding_audit_json TEXT NOT NULL DEFAULT '[]',
        warnings_json TEXT NOT NULL DEFAULT '[]',
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (job_url, generation, item_id)
      );
    `);
    db.prepare(
      `INSERT INTO job_interview_prep (
         job_url, generation, tenant_id, status, model, generated_at, gate_status,
         fabrication_findings_json, grounding_findings_json, judge_verdict,
         warnings_json, failure_reason
       ) VALUES (?, 1, 'local', 'accepted', 'e2e-stub', ?, 'passed', '[]', '[]', 'grounded', '[]', '')
       ON CONFLICT(job_url, generation) DO UPDATE SET
         status = excluded.status,
         model = excluded.model,
         generated_at = excluded.generated_at,
         gate_status = excluded.gate_status,
         judge_verdict = excluded.judge_verdict`,
    ).run(JOB_URL, occurredAt);
    db.prepare(
      `INSERT INTO job_interview_prep_items (
         job_url, generation, item_id, tenant_id, kind, title, generated_text,
         evidence_ids_json, requirement_ids_json, source_text_json, transform_type,
         control, grounding_audit_json, warnings_json, position
       ) VALUES (?, 1, 'prep-e2e-star', 'local', 'star_draft', 'Platform ownership story',
         'Use the platform ownership story to answer systems and team-enablement questions.',
         '["ev_platform"]', '["r1"]', '["Owned the developer platform across product teams."]',
         'grounded_prep', 'never_fabricate', '["ev_platform supports the STAR draft."]', '[]', 0)
       ON CONFLICT(job_url, generation, item_id) DO UPDATE SET
         title = excluded.title,
         generated_text = excluded.generated_text`,
    ).run(JOB_URL);
    db.prepare(
      `INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      JOB_URL,
      "interview_prep",
      "InterviewPrepGenerated",
      "info",
      "QA E2E injected InterviewPrepGenerated event",
      occurredAt,
      JSON.stringify({
        tenantId: "local",
        jobId: JOB_URL,
        generation: 1,
        status: "accepted",
      }),
    );
  } finally {
    db.close();
  }
}

test("Interview prep: explicit generation queues and accepted prep surfaces with provenance link", async ({
  page,
}) => {
  const dbPath = loadDbPath();
  refreshWorkerHeartbeat(dbPath);
  page.on("dialog", (dialog) => void dialog.accept());

  await page.goto("/jobs");
  const row = page
    .locator("table.jobs-data-grid-table tbody tr")
    .filter({ hasText: "Director of Platform Engineering" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row
    .getByRole("button", { name: /^Open job Director of Platform Engineering/ })
    .click();

  const drawer = page.getByRole("dialog", { name: "Job details" });
  await expect(drawer).toBeVisible({ timeout: 10_000 });

  const generateButton = drawer.getByRole("button", { name: /generate interview prep/i });
  await expect(generateButton).toBeEnabled();

  const [dispatchResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes("/actions/generate-interview-prep") &&
        response.request().method() === "POST",
      { timeout: 30_000 },
    ),
    generateButton.click(),
  ]);
  expect(dispatchResponse.status()).toBe(202);
  expect(await dispatchResponse.json()).toMatchObject({
    ok: true,
    action: "generate_interview_prep",
    status: "queued",
  });

  seedAcceptedPrep(dbPath, new Date().toISOString());

  await expect(drawer.getByRole("heading", { name: "Platform ownership story" })).toBeVisible({
    timeout: 30_000,
  });

  const reflectionNote = "Asked how the platform migration should be sequenced.";
  await drawer.getByLabel("Interview date").fill("2026-06-01T13:20");
  await drawer.getByLabel("Reflection note").fill(reflectionNote);
  const [outcomeResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes("/outcomes") && response.request().method() === "POST",
      { timeout: 30_000 },
    ),
    drawer.getByRole("button", { name: /record reflection/i }).click(),
  ]);
  expect(outcomeResponse.status()).toBe(200);
  expect(await outcomeResponse.json()).toMatchObject({
    ok: true,
    outcome: {
      kind: "interview",
      interviewPrepGeneration: 1,
      note: reflectionNote,
    },
  });
  const reflections = drawer.getByLabel("Post-interview reflections");
  await expect(reflections.getByText(reflectionNote)).toBeVisible();
  await expect(reflections.getByText("prep generation 1")).toBeVisible();

  await expect(drawer.getByRole("link", { name: "ev_platform" })).toBeVisible();
  await drawer.getByRole("link", { name: "ev_platform" }).click();
  await expect(page).toHaveURL(/\/evidence-map\?.*entry=ev_platform/);
});
