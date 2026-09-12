import { expect, test } from "@playwright/test";
import type { ApplyReviewQueueResponse } from "@jobctrl/contracts";

import { seedQaShippedFitLifecycle } from "../../../api/test/qa-seed.js";
import { loadE2eDbPath, QA_PLATFORM_JOB_ID } from "../fixtures/e2e-state.js";

// No route interception: canonical SQLite metadata flows through the real API.
for (const lifecycle of ["post_voice_shipped", "post_acceptance_audit"] as const) {
  test(`${lifecycle} labels final findings without rewriting the acceptance gate`, async ({ page }, testInfo) => {
    const restore = seedQaShippedFitLifecycle(loadE2eDbPath(), lifecycle);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    try {
      const queueResponse = page.waitForResponse((response) =>
        new URL(response.url()).pathname === "/v1/apply/review-queue" && response.request().method() === "GET",
      );
      await page.goto(`/apply-review?jobKey=${encodeURIComponent(QA_PLATFORM_JOB_ID)}`);
      const response = await queueResponse;
      expect(response.status()).toBe(200);
      const queue = await response.json() as ApplyReviewQueueResponse;
      const item = queue.items.find((candidate) => candidate.jobKey === QA_PLATFORM_JOB_ID)!;
      const audit = item.materialsPreview.requirementLedAudit!;
      expect(audit.shippedFit).toMatchObject({
        lifecycle, score: lifecycle === "post_voice_shipped" ? 6 : 5,
        mustHaveCoverage: lifecycle === "post_voice_shipped" ? 1 : 0.5, passed: false,
        claimedOnlyRequirementIds: ["r2"],
        coverageBasis: lifecycle === "post_voice_shipped" ? "grounded_shipped_text_v1" : "judge_claimed_legacy",
      });
      expect(audit.revision).toMatchObject({ score: 7, mustHaveCoverage: 0.5, reviewBlocked: true });
      expect(audit.coveredRequirements.map((requirement) => requirement.id)).toEqual(["r1"]);
      expect(audit.uncoveredRequirements.map((requirement) => requirement.id)).toEqual(["r2"]);

      await expect(page).toHaveURL(/\/apply-review\?jobKey=/);
      await expect(page.getByRole("heading", { name: "Application review", exact: true })).toBeVisible();
      const auditRegion = page.getByRole("region", { name: "Requirement-led tailoring audit" });
      const shipped = auditRegion.locator(".apply-review-audit-shipped-fit");
      await shipped.scrollIntoViewIfNeeded();
      await expect(shipped).toContainText(lifecycle === "post_voice_shipped" ? "Shipped fit: 6/10" : "Shipped fit: 5/10");
      await expect(shipped).toContainText(lifecycle === "post_voice_shipped" ? "Must-have coverage: 100%" : "Must-have coverage: 50%");
      await expect(shipped).toContainText("below revision gate");
      await expect(auditRegion).toContainText("Fit gate: 7/10");
      await expect(auditRegion).toContainText("Gate-recorded coverage: 50%");
      if (lifecycle === "post_voice_shipped") {
        await expect(shipped).toContainText("Post-voice gate findings");
        await expect(shipped).toContainText("grounded (shipped text)");
        await expect(shipped).toContainText("Shipped grounded must-have coverage 100% (fit 6/10) is below the revision gate (80% / 7).");
        await expect(shipped).not.toContainText("Post-acceptance audit findings");
      } else {
        await expect(shipped).toContainText("Post-acceptance audit findings");
        await expect(shipped).toContainText("judge-claimed (legacy)");
        await expect(shipped).toContainText("Recorded after acceptance; this audit did not influence the accepted resume.");
        await expect(shipped).not.toContainText("Post-voice gate findings");
        await expect(shipped).not.toContainText("grounded (shipped text)");
      }
      // Disclosing the real job-position panel preserves the same audit on reopen.
      await page.getByRole("button", { name: "Collapse job position" }).click();
      await expect(auditRegion).not.toBeVisible();
      await page.getByRole("button", { name: "Expand job position" }).click();
      await shipped.scrollIntoViewIfNeeded();
      await expect(shipped).toBeVisible();
      await expect(page.locator("vite-error-overlay")).toHaveCount(0);
      expect(errors).toEqual([]);
      await testInfo.attach(`${lifecycle}-audit`, { body: await auditRegion.screenshot(), contentType: "image/png" });
    } finally {
      restore();
    }
  });
}
