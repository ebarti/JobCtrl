import type { PipelineOperationsSnapshot } from "@jobctrl/contracts";
import { expect, test, type Route } from "@playwright/test";

import {
  pipelinesDiscoveringSnapshot,
  pipelinesRecoveringProjectionSnapshot,
} from "../../src/views/pipelines/PipelinesView.fixtures.js";

test.skip(process.env["JOBCTRL_E2E_ISOLATED"] !== "1", "Requires the owned synthetic API workspace");

test("a confirmed Target search save stays saved while its profile query catches up", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1216, height: 1228 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") errors.push(message.text());
  });
  const initial = await (await page.request.get("/v1/profile")).json();
  await page.goto("/discovery");
  await expect(page).toHaveTitle(/JobCtrl.*Discovery/);
  await expect(page.getByRole("button", { name: "Suggest roles" })).toBeEnabled();
  const laggingRead = async (route: Route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: initial });
    } else {
      await route.continue();
    }
  };
  await page.route("**/v1/profile", laggingRead);
  await page.getByRole("textbox", { name: "Target roles 1", exact: true }).fill("Synthetic Saved Director");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Discovery settings saved", { exact: true })).toBeVisible();
  await expect(page.getByText("Your changes are saved. Updating suggestions to use the latest profile.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Update draft with saved changes" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Suggest roles" })).toBeDisabled();
  const saved = await (await page.request.get("/v1/profile")).json();
  expect(saved.profileVersion).toBeGreaterThan(initial.profileVersion);
  expect(saved.profile.experience.target_role).toContain("Synthetic Saved Director");
  await page.screenshot({ path: testInfo.outputPath("target-search-saved-query-pending.png") });
  await page.unroute("**/v1/profile", laggingRead);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Target roles 1", exact: true })).toHaveValue("Synthetic Saved Director");
  await expect(page.getByRole("button", { name: "Suggest roles" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Update draft with saved changes" })).toHaveCount(0);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("target-search-saved.png") });
  expect(errors).toEqual([]);
});

test("Discover explains occupied slots and unlocks automatically after the runtime becomes idle", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1216, height: 1228 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") errors.push(message.text());
  });
  let dispatches = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/v1/pipeline/actions/run-stage") dispatches += 1;
  });
  const capacity = pipelinesDiscoveringSnapshot.capacity;
  if (capacity.status !== "available") throw new Error("Expected available fixture capacity");
  const busy: PipelineOperationsSnapshot = {
    ...pipelinesDiscoveringSnapshot,
    execution: {
      ...pipelinesDiscoveringSnapshot.execution!,
      workflowStatus: "succeeded",
      phase: "draining",
      membershipClosed: true,
      finishedAt: "2026-07-14T12:00:00.000Z",
    },
    activeStageCounts: [{ stage: "score", count: 1 }],
    activeItems: [{
      kind: "unresolved_runtime_activity",
      activityType: "check_saved_posting_availability",
      workflowId: null,
      executionId: null,
      attempt: 1,
      startedAt: "2026-07-14T12:01:00.000Z",
      stage: null,
      opaqueId: `op_${"1".repeat(24)}`,
    }],
    activeItemsTotal: 2,
    activeItemsTruncated: true,
    capacity: { ...capacity, activeSlots: 2, availableSlots: capacity.configuredSlots - 2, slotSaturation: 2 / capacity.configuredSlots },
  };
  const idle: PipelineOperationsSnapshot = {
    ...busy,
    activeStageCounts: [],
    activeItems: [],
    activeItemsTotal: 0,
    activeItemsTruncated: false,
    capacity: { ...capacity, activeSlots: 0, availableSlots: capacity.configuredSlots, slotSaturation: 0 },
  };
  let idleObserved = false;
  await page.route("**/v1/pipeline/operations", (route) => route.fulfill({ json: idleObserved ? idle : busy }));
  await page.goto("/pipelines");
  await expect(page).toHaveTitle(/JobCtrl.*Pipelines/);
  const discover = page.getByRole("button", { name: "Run Discover" });
  await expect(discover).toBeDisabled();
  await expect(page.getByRole("group", { name: "Pipeline action tools" }).getByText("waiting", { exact: true })).toBeVisible();
  await expect(discover).toHaveAccessibleDescription(
    "Discover is waiting for 2 running worker tasks to finish. Active stages: Score 1. Status updates automatically. Review active runs to inspect progress or cancel work.",
  );
  await expect(page.getByRole("link", { name: "Review active runs" })).toHaveAttribute("href", "/runs");
  await expect(page.getByRole("heading", { name: "Saved posting checks" })).toBeVisible();
  await discover.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("discover-waiting-explained.png") });
  idleObserved = true;
  await expect(discover).toBeEnabled({ timeout: 20_000 });
  await expect(page.getByRole("link", { name: "Review active runs" })).toHaveCount(0);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await discover.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("discover-idle-enabled.png") });
  expect(dispatches).toBe(0);
  expect(errors).toEqual([]);
});

test("pending Discover records show progress and become ready on the next automatic refresh", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1216, height: 1228 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") errors.push(message.text());
  });
  const pending: PipelineOperationsSnapshot = {
    ...pipelinesRecoveringProjectionSnapshot,
    execution: null,
  };
  let recordsReady = false;
  await page.route("**/v1/pipeline/operations", (route) => route.fulfill({
    json: recordsReady ? pipelinesDiscoveringSnapshot : pending,
  }));
  await page.goto("/pipelines");
  const alert = page.getByRole("alert").filter({ hasText: "Checking Discover run records" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("15 of 72 linked jobs recorded");
  await expect(alert).toContainText("3 of 8 stage records stored");
  await expect(alert.locator("time")).toHaveAttribute("datetime", pending.projectionCoverage!.updatedAt!);
  await expect(alert).toContainText("updates every 15 seconds while visible");
  await expect(alert).not.toContainText("previous Discover run");
  await expect(page.getByRole("region", { name: "Live pipeline", exact: true })).not.toContainText("previous run");
  await expect(page.getByRole("region", { name: "Plan sources stage" })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("discover-record-check-progress.png") });
  recordsReady = true;
  await expect(alert).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByRole("region", { name: "Plan sources stage" })).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("discover-record-check-ready.png") });
  expect(errors).toEqual([]);
});
