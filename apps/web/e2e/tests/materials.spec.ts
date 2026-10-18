import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { ApplyReviewQueueResponse } from "@jobctrl/contracts";

import { loadE2eDbPath, QA_PLATFORM_JOB_ID } from "../fixtures/e2e-state.js";

// Real API/RPC renderer path. Keep this separate from controlled-response
// browser race tests: no render/save/PDF route is intercepted here.
for (const fontFamily of ["georgia", "times", "arial"] as const) for (const settings of [
  { paper: "A4", fontSize: "9", margin: "8", lineHeight: "1", paragraphSpacing: "0" },
  { paper: "Letter", fontSize: "14", margin: "28", lineHeight: "2", paragraphSpacing: "24" },
]) test(`cover-letter ${settings.paper}/${fontFamily} preview accepts identical bytes explicitly and survives reload`, async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const queue = await page.request.get("/v1/apply/review-queue");
  expect(queue.ok()).toBe(true);
  const original = (await queue.json() as ApplyReviewQueueResponse).items.find(row => row.jobKey === QA_PLATFORM_JOB_ID)!;
  expect(original?.materialsPreview.coverLetter).toBeTruthy();
  const originalCover = original.materialsPreview.coverLetter!;
  await page.goto(`/apply-review?jobKey=${QA_PLATFORM_JOB_ID}`);
  const surface = page.getByRole("region", { name: "Cover-letter PDF formatting" });
  await expect(surface).toBeVisible();
  await surface.getByRole("combobox", { name: "Paper size" }).click();
  await page.getByRole("option", { name: settings.paper, exact: true }).click();
  await surface.getByRole("combobox", { name: "Font family" }).click();
  await page.getByRole("option", { name: fontFamily, exact: true }).click();
  await surface.getByLabel("Font size (pt)").fill(settings.fontSize);
  await surface.getByLabel("Margins (mm)").fill(settings.margin);
  await surface.getByLabel("Line spacing", { exact: true }).fill(settings.lineHeight);
  await surface.getByLabel("Paragraph spacing (px)").fill(settings.paragraphSpacing);
  const renderResponse = page.waitForResponse(response => response.url().endsWith("/cover-letter/preview") && response.request().method() === "POST");
  await surface.getByRole("button", { name: "Preview cover-letter PDF" }).click();
  expect((await renderResponse).ok()).toBe(true);
  await expect(surface.locator(".pdf-preview-toolbar .toolbar-status")).toHaveText(/^\d+ pages?$/, { timeout: 60_000 });
  const previewUrl = await surface.getByRole("link", { name: "Download displayed cover-letter PDF" }).getAttribute("href");
  const preview = await page.request.get(previewUrl!);
  expect(preview.ok()).toBe(true);
  const bytes = await preview.body();
  const digest = createHash("sha256").update(bytes).digest("hex");
  await testInfo.attach(`cover-preview-${settings.paper}`, { body: bytes, contentType: "application/pdf" });
  const unchanged = await page.request.get("/v1/apply/review-queue");
  expect((await unchanged.json() as ApplyReviewQueueResponse).items.find(row => row.jobKey === QA_PLATFORM_JOB_ID)!.materialsPreview.coverLetter).toEqual(originalCover);
  const saveResponse = page.waitForResponse(response => response.url().endsWith("/cover-letter/accept") && response.request().method() === "POST");
  await surface.getByRole("button", { name: "Save cover-letter PDF" }).click();
  const savedResponse = await saveResponse;
  expect(savedResponse.ok()).toBe(true);
  const { accepted } = await savedResponse.json();
  expect(accepted.pdfSha256).toBe(digest);
  const downloaded = await page.request.get(`/v1/artifacts/${accepted.pdfArtifactId}/preview.pdf`);
  expect(downloaded.ok()).toBe(true);
  expect(await downloaded.body()).toEqual(bytes);
  await page.reload();
  await expect(surface.getByLabel("Font size (pt)")).toHaveValue(settings.fontSize);
  await expect(surface.getByRole("combobox", { name: "Paper size" })).toContainText(settings.paper);
  await expect(surface.getByRole("combobox", { name: "Font family" })).toContainText(fontFamily);
  const reloaded = (await (await page.request.get("/v1/apply/review-queue")).json() as ApplyReviewQueueResponse).items.find(row => row.jobKey === QA_PLATFORM_JOB_ID)!;
  expect(reloaded.materialsPreview.coverLetter).toEqual(accepted);
  expect(reloaded.materialsPreview.resumePdfArtifactId).toBe(original.materialsPreview.resumePdfArtifactId);
  expect(reloaded.materialsPreview.resumeTextArtifactId).toBe(original.materialsPreview.resumeTextArtifactId);
  const pages = surface.locator(".pdf-preview-page");
  await expect(surface.locator(".pdf-preview-toolbar .toolbar-status")).toHaveText(/^\d+ pages?$/);
  for (let index = 0; index < await pages.count(); index++) {
    await testInfo.attach(`cover-accepted-page-${index + 1}`, { body: await pages.nth(index).screenshot(), contentType: "image/png" });
  }
});

// The seeded worker heartbeat is written once at global-setup; the suite runs
// serially and can exceed the 45s staleness window before this spec runs. Refresh
// it to "now" so the worker-readiness gate passes regardless of suite ordering —
// the test owns its own worker-ready precondition.
function refreshWorkerHeartbeat(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.prepare("UPDATE worker_runtime_heartbeats SET last_seen_at = ?").run(new Date().toISOString());
  } finally {
    db.close();
  }
}

// INSPECT-01: per-job material generation is invokable from the product surface.
// The generate-materials route returns 202 (not 400), the button is enabled, and
// the worker-confirmed approval reflects in-app via the SSE realtime loop. The
// dispatch is stubbed (JOBCTRL_E2E_STUB_DISPATCH) so the spec exercises the
// route + UI wiring without a worker subprocess or LLM; the terminal
// ResumeApproved event is injected into SQLite exactly as dry-run.spec.ts does.
test("Generate materials: button enabled → dispatch queued → ResumeApproved surfaces in audit history", async ({
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
  // Row activation is the named per-row "Open" button, not a whole-row click:
  // structural rows stay non-interactive for accessibility.
  const rowActivation = row.getByRole("button", {
    name: /^Open job Director of Platform Engineering/,
  });
  await rowActivation.focus();
  await expect(rowActivation).toBeFocused();
  await rowActivation.press("Enter");

  const drawer = page.getByRole("article", { name: "Job details" });
  await expect(drawer).toBeVisible({ timeout: 10_000 });

  const moreActions = drawer.getByRole("button", {
    name: "More job actions",
  });
  await moreActions.click();
  await expect(moreActions).toHaveAttribute("aria-expanded", "true");

  // The button is enabled (no longer the disabled "not yet wired" stub).
  const generateButton = page
    .getByRole("toolbar", { name: "Job actions" })
    .getByRole("button", { name: /generate materials/i });
  await expect(generateButton).toBeEnabled();

  // Capture the dispatch response to prove the route returns 202 (not 400).
  const [dispatchResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes("/actions/generate-materials") && response.request().method() === "POST",
      { timeout: 30_000 },
    ),
    generateButton.click(),
  ]);
  expect(dispatchResponse.status()).toBe(202);
  expect(await dispatchResponse.json()).toMatchObject({ ok: true, action: "run_stage", status: "queued" });

  // Drive the worker-confirmed terminal state through the realtime loop: inject a
  // ResumeApproved event, which the SSE pipeline streams to the invalidation
  // router → refreshes the job detail → the drawer's audit history shows it.
  const occurredAt = new Date().toISOString();
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO job_events (
         tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json
       ) VALUES ('local', ?, 1, ?, ?, ?, ?, ?, ?)`,
    ).run(
      QA_PLATFORM_JOB_ID,
      "tailor",
      "ResumeApproved",
      "info",
      "QA E2E injected ResumeApproved event",
      occurredAt,
      JSON.stringify({
        tenantId: "local",
        jobId: QA_PLATFORM_JOB_ID,
        artifactId: "qa-e2e-resume",
        generation: 2,
        approvedAt: occurredAt,
      }),
    );
  } finally {
    db.close();
  }

  // Expand the audit history disclosure and assert the approval surfaced. The
  // disclosure summary is the stable target (the body may briefly render the
  // empty state before the injected event arrives via SSE).
  const auditDetails = drawer.locator("details.job-audit-disclosure");
  await auditDetails.locator("summary", { hasText: "Technical details" }).click();
  await expect(auditDetails.getByText(/resume approved/i)).toBeVisible({ timeout: 30_000 });
});
