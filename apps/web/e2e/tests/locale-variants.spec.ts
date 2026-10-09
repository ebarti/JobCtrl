import { test, expect } from "@playwright/test";
import { QA_PLATFORM_JOB_ID } from "../fixtures/e2e-state.js";

// Browser/client wiring fixture only. Native Python model-port QA is a separate gate.
test("locale review is independent and a failed refresh preserves accepted content", async ({ page }) => {
  const text = "Synthetic Name · Historical Title · 2020\nDelivered 25%";
  const citation = { source_id: "source:1", quote: "Delivered 25%", exact_values: ["25"] };
  const revision = {
    contract: "material-locale-v1", tenantId: "local", jobId: QA_PLATFORM_JOB_ID, entityId: "synthetic-binding",
    authorityStatus: "recorded",
    source: { artifactId: "source-resume", generation: 1, kind: "tailored_resume", sha256: "a".repeat(64), text },
    sourceLocale: "en", targetLocale: "es", profileVersion: 1, facts: [{ source_id: "fact", text: "Delivered 25%" }], protectedValues: ["Historical Title"],
    revisionId: "90000000-0000-4000-8000-000000000040", version: 1, createdAt: "2026-10-09T10:00:00Z", accepted: false,
    reviews: [] as Record<string, unknown>[], acceptanceHistory: [] as Record<string, unknown>[], exports: [], translationId: "a".repeat(64), verificationId: "b".repeat(64),
    provider: "synthetic", model: "structural-model", promptVersion: "material-locale-translation-v1", schemaVersion: "1",
    lines: [{ line_id: "source:1", text: "Delivered 25%", source: citation, fact_ids: ["fact"] }], findings: [], verificationVerdict: "pass", text, textSha256: "c".repeat(64),
    verification: [{ line_id: "source:1", verdict: "pass", original: citation, translated: { ...citation, source_id: "translated:source:1" }, reason: "Explicit synthetic verdict" }],
  };
  await page.route(`**/v1/jobs/${QA_PLATFORM_JOB_ID}/material-locales`, async route => {
    const request = route.request().postDataJSON();
    if (request.operation === "generate") { await route.fulfill({ status: 409, json: { ok: false, error: "stale_locale_source" } }); return; }
    if (request.operation === "review") {
      expect(request.expectedVersion).toBe(revision.version);
      revision.reviews.push({ dimension: request.dimension, decision: request.decision, note: request.note, revisionId: revision.revisionId, textSha256: revision.textSha256, recordedAt: "2026-10-09T10:01:00Z" });
      revision.version++;
    }
    if (request.operation === "accept") {
      expect(revision.reviews.map(row => row["dimension"])).toEqual(["terminology", "formatting"]);
      revision.accepted = true; revision.version++;
      revision.acceptanceHistory.push({ decision: "accepted", recordedAt: "2026-10-09T10:02:00Z", revisionId: revision.revisionId, textSha256: revision.textSha256 });
    }
    await route.fulfill({ json: { supportedLocales: ["en", "es"], sources: [{ artifactId: "source-resume", generation: 1, kind: "tailored_resume" }], profileVersion: 1, variants: [revision] } });
  });
  await page.goto("/jobs");
  const row = page.locator("table.jobs-data-grid-table tbody tr").filter({ hasText: "Director of Platform Engineering" });
  await row.getByRole("button", { name: /^Open job Director of Platform Engineering/ }).click();
  const panel = page.getByRole("region", { name: "Reviewed locale variants" });
  // The section's explicit accessible name works as a region without a new app route.
  await expect(panel.getByRole("button", { name: "Accept locale revision" })).toBeDisabled();
  await panel.getByRole("button", { name: "Approve terminology" }).click();
  await expect(panel.getByText("terminology: accepted").first()).toBeVisible();
  await expect(panel.getByRole("button", { name: "Accept locale revision" })).toBeDisabled();
  await panel.getByRole("button", { name: "Approve formatting" }).click();
  await expect(panel.getByRole("button", { name: "Accept locale revision" })).toBeEnabled();
  await panel.getByRole("button", { name: "Accept locale revision" }).click();
  for (const format of ["TXT", "HTML", "PDF", "DOCX"]) await expect(panel.getByRole("button", { name: `Export ${format}` })).toBeEnabled();
  await panel.getByRole("button", { name: "Generate locale variant" }).click();
  await expect(panel.getByRole("alert")).toContainText("Accepted revisions remain available");
  await expect(panel.getByRole("button", { name: "Export TXT" })).toBeVisible();
  await expect(panel.getByText(text).first()).toBeVisible();
});
