import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import type { ApplyReviewQueueResponse } from "@jobctrl/contracts";

import { loadE2eDbPath, QA_PLATFORM_JOB_ID } from "../fixtures/e2e-state.js";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const { assertPdfMeasurementTools } = createRequire(import.meta.url)("../fixtures/pdf-measurement-tools.cjs") as {
  assertPdfMeasurementTools(): void;
};
test.beforeAll(() => { assertPdfMeasurementTools(); });
const fullCoverText = Array.from({ length: 18 }, (_, index) => [
  `Paragraph ${index + 1}: Zoë's résumé costs €0.`,
  `Literal <b>tags</b> & "quotes" stay visible.`,
  `Full accepted source line ${index + 1}; end of paragraph.`,
].join("\n")).join("\n\n") + "\n\nEND OF COMPLETE SYNTHETIC LETTER";

function seedFullCoverText(): void {
  const dbPath = loadE2eDbPath(); // asserts the isolated workspace ownership
  const db = new Database(dbPath);
  try {
    const source = db.prepare(`SELECT path FROM job_materials_artifacts WHERE tenant_id='local' AND job_id=?
      AND artifact_type IN ('cover_letter','cover_letter_txt') AND status='approved' AND superseded_at IS NULL
      ORDER BY generation DESC,created_at DESC,rowid DESC LIMIT 1`).get(QA_PLATFORM_JOB_ID) as { path: string };
    const root = fs.realpathSync(process.env["JOBCTRL_E2E_APP_DIR"]!);
    const file = fs.realpathSync(source.path);
    expect(file.startsWith(root + path.sep)).toBe(true);
    fs.writeFileSync(file, fullCoverText);
  } finally { db.close(); }
}

// Real API/RPC renderer path. Keep this separate from controlled-response
// browser race tests: no render/save/PDF route is intercepted here.
for (const fontFamily of ["georgia", "times", "arial"] as const) for (const settings of [
  { paper: "A4", fontSize: "9", margin: "8", lineHeight: "1", paragraphSpacing: "0" },
  { paper: "Letter", fontSize: "14", margin: "28", lineHeight: "2", paragraphSpacing: "24" },
  { paper: "Letter", fontSize: "11", margin: "17.78", lineHeight: "1.6", paragraphSpacing: "14" },
]) test(`cover-letter ${settings.paper}/${fontFamily}/${settings.fontSize}pt preview accepts identical bytes explicitly and survives reload`, async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  seedFullCoverText();
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
  const rendered = await renderResponse;
  expect(rendered.ok()).toBe(true);
  const renderReceipt = await rendered.json();
  await expect(surface.locator(".pdf-preview-toolbar .toolbar-status")).toHaveText(/^\d+ pages?$/, { timeout: 60_000 });
  const previewUrl = await surface.getByRole("link", { name: "Download displayed cover-letter PDF" }).getAttribute("href");
  const preview = await page.request.get(previewUrl!);
  expect(preview.ok()).toBe(true);
  const bytes = await preview.body();
  const digest = createHash("sha256").update(bytes).digest("hex");
  await testInfo.attach(`cover-preview-${settings.paper}`, { body: bytes, contentType: "application/pdf" });
  const evidenceDir = testInfo.outputPath("cover-evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "preview.pdf"), bytes);
  fs.writeFileSync(path.join(evidenceDir, "source.txt"), fullCoverText);
  fs.writeFileSync(path.join(evidenceDir, "settings.json"), JSON.stringify(renderReceipt.preview.settings));
  // This measures actual HTTP/RPC/Chromium bytes. Keep its inputs and outputs
  // even when a measurement fails; no recorded PDF or structural seam is used.
  const measurement = spawnSync(path.join(repoRoot, "workers/automation/.venv/bin/python"), [
    path.join(repoRoot, "workers/automation/tests/cover_letter_pdf_probe.py"),
    "--pdf", path.join(evidenceDir, "preview.pdf"), "--source", path.join(evidenceDir, "source.txt"),
    "--settings", path.join(evidenceDir, "settings.json"), "--output", evidenceDir,
  ], { encoding: "utf8", env: process.env });
  fs.writeFileSync(path.join(evidenceDir, "measurement.stdout"), measurement.stdout ?? "");
  fs.writeFileSync(path.join(evidenceDir, "measurement.stderr"), measurement.stderr ?? String(measurement.error ?? ""));
  expect(measurement.status, measurement.stderr).toBe(0);
  const previewPages = surface.locator(".pdf-preview-page");
  for (let index = 0; index < await previewPages.count(); index++) {
    await testInfo.attach(`cover-preview-page-${index + 1}`, { body: await previewPages.nth(index).screenshot(), contentType: "image/png" });
  }
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
  fs.writeFileSync(path.join(evidenceDir, "accepted.pdf"), await downloaded.body());
  fs.writeFileSync(path.join(evidenceDir, "identities.json"), JSON.stringify({ original: originalCover, renderReceipt, accepted,
    previewDownloadSha256: digest, acceptedDownloadSha256: createHash("sha256").update(await downloaded.body()).digest("hex"),
    sourceSha256: createHash("sha256").update(fullCoverText).digest("hex") }, null, 2));
  await page.reload();
  await expect(surface.getByLabel("Font size (pt)")).toHaveValue(settings.fontSize);
  await expect(surface.getByRole("combobox", { name: "Paper size" })).toContainText(settings.paper);
  await expect(surface.getByRole("combobox", { name: "Font family" })).toContainText(fontFamily);
  const reloaded = (await (await page.request.get("/v1/apply/review-queue")).json() as ApplyReviewQueueResponse).items.find(row => row.jobKey === QA_PLATFORM_JOB_ID)!;
  expect(reloaded.materialsPreview.coverLetter).toEqual(accepted);
  expect(await (await page.request.get(`/v1/artifacts/${accepted.pdfArtifactId}/preview.pdf`)).body()).toEqual(bytes);
  expect(reloaded.materialsPreview.resumePdfArtifactId).toBe(original.materialsPreview.resumePdfArtifactId);
  expect(reloaded.materialsPreview.resumeTextArtifactId).toBe(original.materialsPreview.resumeTextArtifactId);
  const pages = surface.locator(".pdf-preview-page");
  await expect(surface.locator(".pdf-preview-toolbar .toolbar-status")).toHaveText(/^\d+ pages?$/);
  for (let index = 0; index < await pages.count(); index++) {
    await testInfo.attach(`cover-accepted-page-${index + 1}`, { body: await pages.nth(index).screenshot(), contentType: "image/png" });
  }
});

test("cover-letter competing saves accept one snapshot and preserve its displayed bytes", async ({ page, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  seedFullCoverText();
  const original = (await (await page.request.get("/v1/apply/review-queue")).json() as ApplyReviewQueueResponse).items.find(row => row.jobKey === QA_PLATFORM_JOB_ID)!;
  const cover = original.materialsPreview.coverLetter!;
  const headers = { origin: new URL(baseURL!).origin };
  const previews = [];
  for (const fontSizePt of [10, 13]) {
    const response = await page.request.post(`/v1/jobs/${QA_PLATFORM_JOB_ID}/cover-letter/preview`, { headers, data: {
      source: cover.source, expectedAcceptedVersion: cover.acceptedVersion, settings: { ...cover.settings, fontSizePt },
    } });
    expect(response.status(), await response.text()).toBe(200);
    previews.push((await response.json()).preview);
  }
  const results = await Promise.all(previews.map(preview => page.request.post(`/v1/jobs/${QA_PLATFORM_JOB_ID}/cover-letter/accept`, {
    headers,
    data: { previewId: preview.previewId, expectedAcceptedVersion: preview.expectedAcceptedVersion },
  })));
  expect(results.map(response => response.status()).sort()).toEqual([200, 409]);
  const winner = results.findIndex(response => response.status() === 200);
  const accepted = (await results[winner]!.json()).accepted;
  const previewBytes = await (await page.request.get(`/v1/jobs/${QA_PLATFORM_JOB_ID}/cover-letter/previews/${previews[winner].previewId}.pdf`)).body();
  expect(await (await page.request.get(`/v1/artifacts/${accepted.pdfArtifactId}/preview.pdf`)).body()).toEqual(previewBytes);
  await page.goto(`/apply-review?jobKey=${QA_PLATFORM_JOB_ID}`);
  const surface = page.getByRole("region", { name: "Cover-letter PDF formatting" });
  await expect(surface.getByLabel("Font size (pt)")).toHaveValue(String(accepted.settings.fontSizePt));
  await expect(surface.locator(".pdf-preview-toolbar .toolbar-status")).toHaveText(/^\d+ pages?$/, { timeout: 60_000 });
  await testInfo.attach("competing-save-receipts.json", { body: JSON.stringify({ previews, statuses: results.map(response => response.status()), accepted }), contentType: "application/json" });
  await testInfo.attach("competing-save-accepted.pdf", { body: previewBytes, contentType: "application/pdf" });
});

// The API/RPC render and acceptance remain real. Only delivery of the committed
// HTTP save acknowledgement and automatic queue-refresh delivery are interrupted;
// this is transport-control evidence, not a mocked render or persistence result.
test("cover-letter lost save acknowledgement reconciles on reload without accepting later edits", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  seedFullCoverText();
  await page.goto(`/apply-review?jobKey=${QA_PLATFORM_JOB_ID}`);
  const surface = page.getByRole("region", { name: "Cover-letter PDF formatting" });
  await surface.getByLabel("Font size (pt)").fill("12");
  await surface.getByRole("button", { name: "Preview cover-letter PDF" }).click();
  await expect(surface.getByRole("button", { name: "Save cover-letter PDF", exact: true })).toBeEnabled({ timeout: 60_000 });
  // A successful canonical refetch can legitimately reconcile a lost save
  // acknowledgement. Keep that transport unavailable until the reload below,
  // so this assertion exercises uncertain-save fencing independently of SSE timing.
  await page.route("**/v1/apply/review-queue", route => route.abort("failed"));
  let committed: unknown;
  await page.route("**/cover-letter/accept", async route => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    committed = await response.json();
    await surface.getByLabel("Font size (pt)").fill("9");
    await route.abort("failed");
  });
  await surface.getByRole("button", { name: "Save cover-letter PDF", exact: true }).click();
  await expect(surface.getByLabel("Font size (pt)")).toHaveValue("9");
  await expect(surface.getByRole("button", { name: "Save cover-letter PDF", exact: true })).toBeDisabled();
  const authorization = page.getByRole("group", { name: "Authorization decision for Director of Platform Engineering", exact: true });
  await expect(authorization.getByRole("button", { name: "Authorize dry run for Director of Platform Engineering", exact: true })).toBeDisabled();
  await expect(authorization.getByRole("button", { name: "Authorize live submit for Director of Platform Engineering", exact: true })).toBeDisabled();
  await expect(authorization.getByRole("button", { name: "Authorize dry run for Director of Platform Engineering", exact: true }))
    .toHaveAttribute("title", "Reload to reconcile the cover-letter save before approval.");
  await testInfo.attach("lost-ack-committed-receipt.json", { body: JSON.stringify(committed), contentType: "application/json" });
  await page.unroute("**/cover-letter/accept");
  await page.unroute("**/v1/apply/review-queue");
  await page.reload();
  await expect(surface.getByLabel("Font size (pt)")).toHaveValue("12");
  const queue = await (await page.request.get("/v1/apply/review-queue")).json() as ApplyReviewQueueResponse;
  expect(queue.items.find(row => row.jobKey === QA_PLATFORM_JOB_ID)!.materialsPreview.coverLetter).toEqual((committed as { accepted: unknown }).accepted);
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
