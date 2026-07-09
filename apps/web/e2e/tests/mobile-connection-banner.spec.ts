import { expect, test } from "@playwright/test";

import { sampleHealthResponse } from "../../src/test/fixtures/projections.js";

test("stale worker alert stays in flow above the Dashboard heading at 390px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/v1/health", async (route) => {
    await route.fulfill({
      json: {
        ...sampleHealthResponse,
        worker: {
          ...sampleHealthResponse.worker,
          status: "stale",
          message:
            "JobCtrl automation worker heartbeat is stale; last seen at test time.",
        },
      },
    });
  });

  await page.goto("/dashboard");

  const alert = page.getByRole("alert");
  const heading = page.getByRole("heading", { name: "Dashboard", level: 1 });
  await expect(alert).toBeVisible();
  await expect(heading).toBeVisible();

  const layout = await page.evaluate(() => {
    const alertElement =
      document.querySelector<HTMLElement>(".connection-banner");
    const headingElement = document.querySelector<HTMLElement>(".page-head h1");
    const topbarElement = document.querySelector<HTMLElement>(".topbar");
    if (!alertElement || !headingElement || !topbarElement) {
      return null;
    }

    const alertRect = alertElement.getBoundingClientRect();
    const headingRect = headingElement.getBoundingClientRect();
    const topbarRect = topbarElement.getBoundingClientRect();
    return {
      alertBottom: alertRect.bottom,
      alertTop: alertRect.top,
      headingTop: headingRect.top,
      topbarBottom: topbarRect.bottom,
      viewportWidth: document.documentElement.clientWidth,
      contentWidth: document.documentElement.scrollWidth,
    };
  });

  expect(layout).not.toBeNull();
  if (!layout) {
    throw new Error(
      "Expected the stale-worker alert, Dashboard heading, and top bar to render.",
    );
  }
  expect(layout.alertTop).toBeGreaterThanOrEqual(0);
  expect(
    layout.alertBottom,
    "the top bar should contain the full stale-worker alert",
  ).toBeLessThanOrEqual(layout.topbarBottom + 1);
  expect(
    layout.alertBottom,
    "the stale-worker alert should not overlap the Dashboard heading",
  ).toBeLessThanOrEqual(layout.headingTop);
  expect(
    layout.contentWidth,
    "the in-flow alert should not introduce horizontal overflow",
  ).toBeLessThanOrEqual(layout.viewportWidth + 1);
});
