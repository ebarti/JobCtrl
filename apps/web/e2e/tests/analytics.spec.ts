import { expect, test } from "@playwright/test";

test("analytics view keeps small samples count-only", async ({ page }) => {
  await page.route("**/v1/analytics/outcomes", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        generatedAt: "2026-06-01T12:00:00Z",
        minSample: 5,
        totals: {
          n: 6,
          applied: 6,
          reply: 3,
          interview: 1,
          offer: 0,
          rejection: 0,
          replyRate: 0.5,
          interviewRate: 0.1667,
          offerRate: 0,
          rejectionRate: 0,
        },
        bySource: [
          {
            source: "greenhouse",
            n: 5,
            applied: 5,
            reply: 2,
            interview: 1,
            offer: 0,
            rejection: 0,
            replyRate: 0.4,
            interviewRate: 0.2,
            offerRate: 0,
            rejectionRate: 0,
          },
          {
            source: "lever",
            n: 1,
            applied: 1,
            reply: 1,
            interview: 0,
            offer: 0,
            rejection: 0,
            replyRate: null,
            interviewRate: null,
            offerRate: null,
            rejectionRate: null,
          },
        ],
        byScoreBand: [],
        byFitBand: [],
        byApplyMode: [],
        byTemplate: [],
        byPolicy: [],
        timeToResponse: {
          n: 0,
          medianMinutes: null,
        },
        suggestionAccuracy: {
          n: 0,
          decided: 0,
          accepted: 0,
          corrected: 0,
          ignored: 0,
          acceptanceRate: null,
        },
      }),
    });
  });

  await page.goto("/analytics");

  await expect(page.getByRole("heading", { name: "Outcome analytics" })).toBeVisible();
  await page.getByText("How rates are calculated").click();
  await expect(page.getByText("Recorded outcomes from canonical rows only")).toBeVisible();
  await expect(page.getByText("not causal claims")).toBeVisible();

  const leverRow = page.getByRole("row").filter({ hasText: "lever" });
  await expect(leverRow).toContainText("n=1");
  await expect(leverRow).toContainText("too few to rate");
  await expect(leverRow).not.toContainText("100%");
});

test("@mobile empty analytics exposes its recovery action without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.route("**/v1/analytics/outcomes", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        generatedAt: "2026-06-01T12:00:00Z",
        minSample: 5,
        totals: {
          n: 0,
          applied: 0,
          reply: 0,
          interview: 0,
          offer: 0,
          rejection: 0,
          replyRate: null,
          interviewRate: null,
          offerRate: null,
          rejectionRate: null,
        },
        bySource: [],
        byScoreBand: [],
        byFitBand: [],
        byApplyMode: [],
        byTemplate: [],
        byPolicy: [],
        timeToResponse: { n: 0, medianMinutes: null },
        suggestionAccuracy: {
          n: 0,
          decided: 0,
          accepted: 0,
          corrected: 0,
          ignored: 0,
          acceptanceRate: null,
        },
      }),
    });
  });

  await page.goto("/analytics");

  const recoveryAction = page.getByRole("link", {
    name: /Review applied jobs/i,
  });
  await expect(page.getByText("No outcome history yet")).toBeVisible();
  await expect(recoveryAction).toBeVisible();
  await expect(page.getByText("How rates are calculated")).toBeVisible();
  await expect(page.getByText("No replies")).toBeVisible();
  await expect(page.getByText("No decisions")).toBeVisible();

  const viewportEvidence = await page.evaluate(() => {
    const action = document.querySelector<HTMLElement>('.analytics-onboarding [role="link"]');
    return {
      actionBottom: action?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY,
      innerHeight: window.innerHeight,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(viewportEvidence.actionBottom).toBeLessThanOrEqual(viewportEvidence.innerHeight);
  expect(viewportEvidence.overflow).toBeLessThanOrEqual(1);
});
