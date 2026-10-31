import fs from "node:fs";

import Database from "better-sqlite3";
import { expect, test } from "@playwright/test";

import { loadE2eDbPath, QA_PLATFORM_JOB_ID, refreshE2eWorkerHeartbeat } from "../fixtures/e2e-state.js";

test.skip(process.env["JOBCTRL_E2E_ISOLATED"] === "1", "Requires the real local stage-reset RPC");

test("bulk retry explains why approved materials require explicit re-tailor", async ({ page }, testInfo) => {
  const db = new Database(loadE2eDbPath());
  const approved = db.prepare(`SELECT artifact_id,path,metadata_json FROM job_materials_artifacts
    WHERE tenant_id='local' AND job_id=? AND artifact_type='tailored_resume' AND status='approved'`).get(QA_PLATFORM_JOB_ID) as {
      artifact_id: string; path: string; metadata_json: string;
    };
  const bytes = fs.readFileSync(approved.path);
  db.prepare(`UPDATE job_stage_states SET state='failed',attempt_count=2,retryable=1,
    error_code='SYNTHETIC_FAILURE',error_message='Synthetic retry check',metadata_json='{"activityOwner":"old"}'
    WHERE tenant_id='local' AND job_id=? AND stage='tailor'`).run(QA_PLATFORM_JOB_ID);
  db.prepare(`INSERT INTO job_events
    (tenant_id,job_id,identity_version,stage,event_type,level,message,occurred_at,payload_json)
    VALUES ('local',?,1,'tailor','StageFailed','error','Synthetic retry check',?,?)`)
    .run(QA_PLATFORM_JOB_ID, new Date().toISOString(), JSON.stringify({ retryable: true }));
  db.close();
  refreshE2eWorkerHeartbeat();

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto("/jobs?state=failed");
  await expect(page).toHaveTitle(/JobCtrl/);
  const row = page.locator("table.jobs-data-grid-table tbody tr").filter({ hasText: "Director of Platform Engineering" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("checkbox").click();
  await page.getByRole("button", { name: "Job operations" }).click();
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes("/v1/jobs/bulk-retry-failed") && response.request().method() === "POST",
  );
  await page.getByRole("menuitem", { name: "Retry selected" }).click();
  const response = await responsePromise;
  expect(response.status(), await response.text()).toBe(200);
  expect(await response.json()).toMatchObject({ status: "reset", actions: [],
    retailorRequiredJobKeys: [QA_PLATFORM_JOB_ID] });
  await expect(page.getByText(/Use explicit re-tailor to create a replacement/i)).toBeVisible();
  expect(errors).toEqual([]);
  expect(await page.locator("vite-error-overlay").count()).toBe(0);
  const after = new Database(loadE2eDbPath(), { readonly: true });
  try {
    expect(after.prepare("SELECT state,attempt_count,metadata_json FROM job_stage_states WHERE tenant_id='local' AND job_id=? AND stage='tailor'")
      .get(QA_PLATFORM_JOB_ID)).toEqual({ state: "pending", attempt_count: 2, metadata_json: null });
    expect(after.prepare("SELECT artifact_id,path,metadata_json FROM job_materials_artifacts WHERE tenant_id='local' AND job_id=? AND artifact_type='tailored_resume' AND status='approved'")
      .get(QA_PLATFORM_JOB_ID)).toEqual(approved);
    expect(fs.readFileSync(approved.path)).toEqual(bytes);
  } finally {
    after.close();
  }
  await page.screenshot({ path: testInfo.outputPath("retry-material-guidance.png") });
});
