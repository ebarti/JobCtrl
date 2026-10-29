import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";

import { loadE2eDbPath, QA_PLATFORM_JOB_ID } from "../fixtures/e2e-state.js";

function seedAcceptedPreparation(): void {
  const db = new Database(loadE2eDbPath());
  try {
    db.prepare(`INSERT INTO job_interview_prep (
      tenant_id, job_id, generation, status, model, generated_at, gate_status,
      fabrication_findings_json, grounding_findings_json, judge_verdict, warnings_json, failure_reason
    ) VALUES ('local', ?, 1, 'accepted', 'synthetic', '2026-10-01T12:00:00Z', 'passed', '[]', '[]', 'grounded', '[]', '')
    ON CONFLICT(tenant_id, job_id, generation) DO UPDATE SET status = 'accepted'`)
      .run(QA_PLATFORM_JOB_ID);
    db.prepare(`INSERT INTO job_interview_prep_items (
      tenant_id, job_id, generation, item_id, kind, title, generated_text,
      evidence_ids_json, requirement_ids_json, source_text_json, transform_type,
      control, grounding_audit_json, warnings_json, position
    ) VALUES ('local', ?, 1, 'synthetic-prep', 'star_draft', 'Retained synthetic preparation',
      'Synthetic preparation remains visible.', '[]', '[]', '[]', 'grounded_prep',
      'never_fabricate', '[]', '[]', 0)
    ON CONFLICT(tenant_id, job_id, generation, item_id) DO NOTHING`).run(QA_PLATFORM_JOB_ID);
  } finally {
    db.close();
  }
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`history recovery retains drafts at ${viewport.width}px`, async ({ page }, testInfo) => {
    seedAcceptedPreparation();
    await page.setViewportSize(viewport);
    let allowPrep = false;
    let allowNotes = false;
    const prepReads: string[] = [];
    const noteReads: string[] = [];
    const generationCalls: string[] = [];
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().includes("503 (Service Unavailable)")) consoleErrors.push(message.text());
    });
    page.on("request", (request) => {
      if (request.method() === "POST" && /generate-interview-prep/.test(request.url())) generationCalls.push(request.url());
    });
    await page.route(/\/v1\/jobs\/[^/]+\/interview-prep\/history(?:\?.*)?$/, async (route) => {
      prepReads.push(route.request().url());
      if (!allowPrep) return route.fulfill({ status: 503, json: { error: "synthetic_read_failure" } });
      return route.continue();
    });
    await page.route(/\/v1\/jobs\/[^/]+\/interview-notes(?:\?.*)?$/, async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === "GET" && url.searchParams.get("history") === "true") {
        noteReads.push(route.request().url());
        if (!allowNotes) return route.fulfill({ status: 503, json: { error: "synthetic_read_failure" } });
      }
      return route.continue();
    });

    await page.goto(`/interviews?card=B11&job=${QA_PLATFORM_JOB_ID}`);
    await expect(page).toHaveTitle(/Interviews/);
    await expect(page).toHaveURL(/\/interviews\?.*card=B11/);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    await expect(page.getByText("Retained synthetic preparation", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Add question to preparation" }).click();
    const criteria = page.getByRole("textbox", { name: "Known interview criteria (one per line)" });
    const note = page.getByRole("textbox", { name: "Notes for B11" });
    await criteria.fill("Synthetic retained context");
    await note.fill("Synthetic retained draft");
    await page.getByText("Saved note revision history").click();

    const prepRetry = page.getByRole("button", { name: "Retry loading preparation history" });
    const noteRetry = page.getByRole("button", { name: "Retry loading note history" });
    await expect(prepRetry).toBeVisible();
    await expect(noteRetry).toBeVisible();
    for (const retry of [prepRetry, noteRetry]) {
      expect(await retry.evaluate((button) => {
        const control = button.getBoundingClientRect();
        const banner = button.closest(".banner")!.getBoundingClientRect();
        return control.left >= banner.left && control.right <= banner.right && control.right <= window.innerWidth;
      })).toBe(true);
    }
    const prepBefore = prepReads.length;
    await prepRetry.click();
    // The production read policy makes one automatic retry before settling.
    await expect.poll(() => prepReads.length).toBe(prepBefore + 2);
    await expect(prepRetry).toBeEnabled();
    const noteBefore = noteReads.length;
    await noteRetry.click();
    await expect.poll(() => noteReads.length).toBe(noteBefore + 2);
    await expect(noteRetry).toBeEnabled();
    await expect(criteria).toHaveValue("Synthetic retained context");
    await expect(note).toHaveValue("Synthetic retained draft");
    await expect(page.getByText("Retained synthetic preparation", { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("failed-history.png"), fullPage: true });

    allowPrep = true;
    await prepRetry.click();
    await expect(page.getByText("Page 1; 1 generations")).toBeVisible();
    allowNotes = true;
    await noteRetry.click();
    await expect(page.getByText("Page 1; 0 revisions")).toBeVisible();
    await expect(criteria).toHaveValue("Synthetic retained context");
    await expect(note).toHaveValue("Synthetic retained draft");
    await expect(page.getByRole("button", { name: "Remove question from preparation" })).toBeVisible();
    await expect(page.getByText("Retained synthetic preparation", { exact: true }).first()).toBeVisible();
    expect(new Set(prepReads).size).toBe(1);
    expect(new Set(noteReads).size).toBe(1);
    expect(new URL(noteReads[0]!).searchParams.get("questionId")).toBe("B11");
    expect(generationCalls).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("recovered-history.png"), fullPage: true });
  });
}

test("review comment recovery saves retained findings without a new review", async ({ page }, testInfo) => {
  const seeds: { url: string; body: unknown }[] = [];
  const generationCalls: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("503 (Service Unavailable)")) errors.push(message.text());
  });
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/actions\/(?:generate|tailor|retailor)/.test(request.url())) generationCalls.push(request.url());
  });
  await page.route(/\/v1\/resume-review\/drafts\/[^/]+\/comment-threads(?:\?.*)?$/, async (route) => {
    seeds.push({ url: route.request().url(), body: route.request().postDataJSON() });
    if (seeds.length === 1) return route.fulfill({ status: 503, json: { error: "synthetic_storage_failure" } });
    return route.continue();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/apply-review?jobKey=${QA_PLATFORM_JOB_ID}`);
  await expect(page).toHaveTitle(/Apply review/);
  await expect(page.getByRole("heading", { name: "Application review", exact: true })).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  const retry = page.getByRole("button", { name: "Retry saving review comments" });
  await expect(retry).toBeVisible();
  await expect(page.getByText(/Retry saving the existing review findings; this does not run a new review/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(retry).toBeVisible();
  expect(await retry.evaluate((button) => {
    const control = button.getBoundingClientRect();
    const banner = button.closest(".banner")!.getBoundingClientRect();
    return control.left >= banner.left && control.right <= banner.right && control.right <= window.innerWidth;
  })).toBe(true);
  await retry.locator("..").screenshot({ path: testInfo.outputPath("comment-recovery.png") });
  const [response] = await Promise.all([
    page.waitForResponse((result) => result.url().includes("/comment-threads") && result.request().method() === "POST" && result.ok()),
    retry.click(),
  ]);
  const persisted = await response.json();
  expect(persisted.ok).toBe(true);
  expect(persisted.seededCount + persisted.updatedCount).toBeGreaterThan(0);
  expect(seeds).toHaveLength(2);
  expect(seeds[1]).toEqual(seeds[0]);
  expect((seeds[0]!.body as { threads: unknown[] }).threads.length).toBeGreaterThan(0);
  await expect(retry).toHaveCount(0);
  expect(generationCalls).toEqual([]);
  expect(errors).toEqual([]);
});
