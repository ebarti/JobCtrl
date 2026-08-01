import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";

import { loadE2eDbPath, QA_PLATFORM_JOB_ID } from "../fixtures/e2e-state.js";

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
    db.prepare(
      `INSERT INTO job_interview_prep (
         tenant_id, job_id, generation, status, model, generated_at, gate_status,
         fabrication_findings_json, grounding_findings_json, judge_verdict,
         warnings_json, failure_reason
       ) VALUES ('local', ?, 1, 'accepted', 'e2e-stub', ?, 'passed', '[]', '[]', 'grounded', '[]', '')
       ON CONFLICT(tenant_id, job_id, generation) DO UPDATE SET
         status = excluded.status,
         model = excluded.model,
         generated_at = excluded.generated_at,
         gate_status = excluded.gate_status,
         judge_verdict = excluded.judge_verdict`,
    ).run(QA_PLATFORM_JOB_ID, occurredAt);
    db.prepare(
      `INSERT INTO job_interview_prep_items (
         tenant_id, job_id, generation, item_id, kind, title, generated_text,
         evidence_ids_json, requirement_ids_json, source_text_json, transform_type,
         control, grounding_audit_json, warnings_json, position
       ) VALUES ('local', ?, 1, 'prep-e2e-star', 'star_draft', 'Platform ownership story',
         'Use the platform ownership story to answer systems and team-enablement questions.',
         '["ev-platform"]', '["r1"]', '["Owned the developer platform across product teams."]',
         'grounded_prep', 'never_fabricate', '["ev-platform supports the STAR draft."]', '[]', 0)
       ON CONFLICT(tenant_id, job_id, generation, item_id) DO UPDATE SET
         title = excluded.title,
         generated_text = excluded.generated_text`,
    ).run(QA_PLATFORM_JOB_ID);
    db.prepare(
      `INSERT INTO job_events (
         tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json
       ) VALUES ('local', ?, 1, ?, ?, ?, ?, ?, ?)`,
    ).run(
      QA_PLATFORM_JOB_ID,
      "interview_prep",
      "InterviewPrepGenerated",
      "info",
      "QA E2E injected InterviewPrepGenerated event",
      occurredAt,
      JSON.stringify({
        tenantId: "local",
        jobId: QA_PLATFORM_JOB_ID,
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
  const dbPath = loadE2eDbPath();
  refreshWorkerHeartbeat(dbPath);
  page.on("dialog", (dialog) => void dialog.accept());

  await page.goto("/jobs");
  const row = page
    .locator("table.jobs-data-grid-table tbody tr")
    .filter({ hasText: "Director of Platform Engineering" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  // Desktop exposes the named row-activation control to keyboard users only.
  // Pointer users activate the visible job title (and Playwright verifies it is
  // not covered by persistent shell chrome).
  const visibleTitle = row
    .locator('[data-slot="title-stack-primary"]')
    .filter({ hasText: /^Director of Platform Engineering$/ });
  await expect(visibleTitle).toBeVisible();
  await visibleTitle.click();

  const drawer = page.getByRole("article", { name: "Job details" });
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

  const evidenceLink = drawer.getByRole("link", {
    name: "Owned platform reliability improvements for incident response.",
  });
  await expect(evidenceLink).toHaveAttribute("href", /entry=ev-platform/);
  await evidenceLink.click();
  await expect(page).toHaveURL(/\/evidence-map\?.*entry=ev-platform/);
});
