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
  await expect(page.getByText("Recorded outcomes from canonical rows only")).toBeVisible();
  await expect(page.getByText("not causal claims")).toBeVisible();

  const leverRow = page.getByRole("row").filter({ hasText: "lever" });
  await expect(leverRow).toContainText("n=1");
  await expect(leverRow).toContainText("too few to rate");
  await expect(leverRow).not.toContainText("100%");
});
