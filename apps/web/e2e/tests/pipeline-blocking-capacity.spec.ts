import { expect, test } from "@playwright/test";

import { pipelinesIdleSnapshot } from "../../src/views/pipelines/PipelinesView.fixtures.js";

test("reports stage refusal separately from short controls and later recovery", async ({ page }) => {
  test.skip(process.env["JOBCTRL_E2E_ISOLATED"] !== "1", "Requires the owned isolated E2E workspace");
  const capacity = pipelinesIdleSnapshot.capacity;
  if (capacity.status !== "available") throw new Error("Expected available synthetic capacity");

  let blockingExecutor: typeof capacity.blockingExecutor | null = {
    acceptingWorkers: 0,
    refusingWorkers: 1,
    unknownWorkers: 0,
    unfinishedRetiredGenerations: 3,
    unfinishedRetiredCalls: 3,
    controlAcceptingWorkers: 1,
    controlRefusingWorkers: 0,
    controlUnknownWorkers: 0,
    controlUnfinishedCalls: 0,
  };
  await page.route("**/v1/pipeline/operations", async (route) => {
    await route.fulfill({
      json: { ...pipelinesIdleSnapshot, capacity: { ...capacity, blockingExecutor } },
    });
  });
  await page.goto("/pipelines");
  await expect(page.getByRole("heading", { name: "Live pipeline" })).toBeVisible();
  const slots = page.getByLabel("Live pipeline metrics").locator(".pipeline-overview-fact")
    .filter({ hasText: "Worker slots in use" });
  await expect(slots).toContainText("0 of 4");
  await expect(slots).toContainText("4 free Temporal slots");
  await expect(slots).toContainText("1 worker refusing stage work");
  await expect(slots).toContainText("Short controls: 1 accepting");
  await page.getByRole("button", { name: /Freshness and capacity/i }).click();
  const inspector = page.getByRole("region", { name: "Worker capacity facts" });
  await expect(inspector).toContainText("Stage work admission");
  await expect(inspector).toContainText("Unfinished retired calls");
  await expect(inspector).toContainText("3 reported");
  await expect(inspector).toContainText("Cancellation does not confirm that they or their child processes stopped.");

  blockingExecutor = { ...blockingExecutor, acceptingWorkers: 1, refusingWorkers: 0,
    unfinishedRetiredGenerations: 2, unfinishedRetiredCalls: 2 };
  await page.reload();
  await expect(slots).toContainText("Workers accepting stage work");
  await page.getByRole("button", { name: /Freshness and capacity/i }).click();
  await expect(inspector).toContainText("2 reported");
  await expect(inspector).toContainText("These calls may still be running.");

  blockingExecutor = null;
  await page.reload();
  await expect(slots).toContainText("Stage work admission unknown");
  await expect(slots).toContainText("Short controls: Unknown");
  await expect(slots).not.toContainText("Workers accepting stage work");
});
