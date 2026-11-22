import { indeedPage } from "./indeed-data.js";
import type { Locator, Page } from "@playwright/test";
import { test, expect, json, action, completed } from "../harness/fixtures.js";
import { createBaseline, createPosting } from "./core-data.js";

async function contentInset(panel: Locator, heading: Locator) {
  await expect(panel).toBeVisible();
  await expect(heading).toBeVisible();
  const [outside, inside] = await Promise.all([panel.boundingBox(), heading.boundingBox()]);
  expect(outside).not.toBeNull();
  expect(inside).not.toBeNull();
  expect(inside!.x - outside!.x, "content has room inside the left panel border").toBeGreaterThanOrEqual(12);
  expect(inside!.y - outside!.y, "content has room inside the top panel border").toBeGreaterThanOrEqual(12);
  expect(inside!.x + inside!.width, "heading stays inside the right panel border").toBeLessThanOrEqual(outside!.x + outside!.width - 12);
}

async function noPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual((await page.viewportSize())!.width + 1);
}

test("expanded operational pages retain readable panel insets filters payloads and history at desktop and mobile widths", async ({ api, app, page }, testInfo) => {
  await createBaseline(api);
  const posting = await createPosting(api, "operational-layout");
  const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", {
    expectedRevision: settings.revision, boards: ["indeed"], hoursOld: 0, newJobLimit: 1, resultsPerSite: 1,
  });
  const discovery = await action(api, "discovery.search", {
    queries: ["Synthetic operational layout engineer"], locations: [{ location: "Madrid", remote: true }],
  });
  const provider = await app.external.next();
  expect(provider.path).toBe("/jobstreaming/indeed");
  provider.respond(indeedPage({ jobs: [], cursor: null, complete: true }));
  await completed(api, discovery.runId);
  const preparation = await action(api, "preparation.run", {
    recipe: "prepare", scope: "selected", job_ids: [posting.job_id], limit: 1, resume_mode: "baseline",
  });
  await completed(api, preparation.runId);
  const savedRuns = await json<{ runs: { runId: string }[] }>(api, "get", "/v1/action-runs");
  const events = await json<{ events: { eventId: string; aggregateId: string }[] }>(api, "get", "/v1/activity?type=JobCaptured&limit=50");
  const eventId = events.events.find((row) => row.aggregateId === posting.job_id)!.eventId;

  async function screenshot(name: string) {
    await noPageOverflow(page);
    await testInfo.attach(name, { contentType: "image/png", body: await page.screenshot({ fullPage: true, animations: "disabled" }) });
  }

  for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 390, height: 844 }]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/pipelines");
    await expect(page.getByRole("heading", { name: "Pipelines", exact: true })).toBeVisible();
    const cohort = page.getByRole("region", { name: "Preparation cohort", exact: true });
    await expect(cohort).toContainText(preparation.runId);
    await cohort.locator("summary").filter({ hasText: /^Inspect target jobs$/ }).click();
    const timing = cohort.locator("summary").filter({ hasText: /^Timing evidence/ });
    await expect(timing.first()).toBeVisible();
    for (const summary of await timing.all()) await summary.click();
    await cohort.locator("summary").filter({ hasText: /^Inspect stage outcomes and run controls$/ }).click();
    await expect(cohort.getByRole("region", { name: "Preparation outcomes", exact: true })).toBeVisible();
    await page.locator("summary").filter({ hasText: /^Inspect recent discovery runs/ }).click();
    for (const name of ["Active work", "Worker and model capacity", "Preparation cohort", "Discovery source progress", "Start preparation"]) {
      const panel = page.getByRole("region", { name, exact: true });
      await contentInset(panel, panel.getByRole("heading", { name, exact: true }));
    }
    await expect(page.getByRole("region", { name: "Pipeline controls", exact: true }).getByRole("button", { name: "Start work", exact: true })).toBeVisible();
    await screenshot(`operational-pipelines-expanded-${viewport.name}`);

    await page.goto("/runs");
    const runFilters = page.locator("details").filter({ has: page.locator("summary").filter({ hasText: /^Filter runs/ }) });
    await runFilters.locator("summary").click();
    await runFilters.getByLabel("Action name", { exact: true }).fill("preparation.run");
    await runFilters.getByRole("button", { name: "Apply filters", exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("workflowType")).toBe("preparation.run");
    await expect(page.locator(".operational-record-list").getByRole("link", { name: "preparation.run", exact: true })).toBeVisible();
    await screenshot(`operational-run-filters-${viewport.name}`);

    await page.goto(`/runs/${preparation.runId}`);
    await expect(page.getByRole("heading", { name: "Run detail", exact: true })).toBeVisible();
    await page.locator("summary").filter({ hasText: /^Recorded result$/ }).click();
    const runPanel = page.locator("section.operational-panel").filter({ has: page.getByRole("heading", { name: "preparation.run", exact: true }) });
    await contentInset(runPanel, runPanel.getByRole("heading", { name: "preparation.run", exact: true }));
    await expect(runPanel.getByRole("region", { name: "Preparation outcomes", exact: true })).toBeVisible();
    await expect(runPanel.locator("pre")).toBeVisible();
    await screenshot(`operational-run-result-${viewport.name}`);

    await page.goto("/debug");
    const activityFilters = page.locator("details").filter({ has: page.locator("summary").filter({ hasText: /^Filter activity/ }) });
    await activityFilters.locator("summary").click();
    await activityFilters.getByLabel("Search events or record IDs", { exact: true }).fill(posting.job_id);
    await activityFilters.getByRole("button", { name: "Apply filters", exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe(posting.job_id);
    await expect(page.locator(".operational-record-list").getByRole("link", { name: "JobCaptured", exact: true })).toBeVisible();
    await screenshot(`operational-activity-filters-${viewport.name}`);

    await page.goto(`/activity/${eventId}`);
    await expect(page.getByRole("heading", { name: "Activity detail", exact: true })).toBeVisible();
    await page.locator("summary").filter({ hasText: /^Event details$/ }).click();
    const eventPanel = page.locator("section.operational-panel").filter({ has: page.getByRole("heading", { name: "JobCaptured", exact: true }) });
    await contentInset(eventPanel, eventPanel.getByRole("heading", { name: "JobCaptured", exact: true }));
    await expect(eventPanel.locator("pre")).toBeVisible();
    await screenshot(`operational-event-details-${viewport.name}`);

    await page.goto("/dashboard");
    for (const name of ["Active work", "Recent activity"]) {
      const panel = page.getByRole("region", { name, exact: true });
      await contentInset(panel, panel.getByRole("heading", { name, exact: true }));
    }
    const applications = page.getByRole("region", { name: "Application activity", exact: true });
    await contentInset(applications, applications.getByRole("heading", { name: "Application activity", exact: true }));
    await contentInset(applications, applications.locator(".detail-list"));
    await contentInset(applications, applications.getByRole("link", { name: "Review applications", exact: true }));
    const seams = await page.locator(".dashboard-tail > .dashboard-panel > .card").evaluateAll((panels) => panels.slice(1).map((panel, index) => {
      const previous = panels[index]!;
      const trailingRow = previous.querySelector(":scope > .rows:last-child > .mini-row:last-child");
      const trailingRowBorder = trailingRow && Math.abs(trailingRow.getBoundingClientRect().bottom - previous.getBoundingClientRect().bottom) <= 1
        ? Number.parseFloat(getComputedStyle(trailingRow).borderBottomWidth)
        : 0;
      return panel.getBoundingClientRect().top - previous.getBoundingClientRect().bottom
        + Number.parseFloat(getComputedStyle(previous).borderBottomWidth)
        + Number.parseFloat(getComputedStyle(panel).borderTopWidth)
        + trailingRowBorder;
    }));
    expect(seams.length).toBeGreaterThan(0);
    for (const seam of seams) {
      expect(seam, "joined Dashboard panels do not overlap").toBeGreaterThanOrEqual(0);
      expect(seam, "joined Dashboard panels have one separator without doubled borders").toBeLessThanOrEqual(1.1);
    }
    await screenshot(`operational-dashboard-panels-${viewport.name}`);
  }
  expect((await json<{ runs: { runId: string }[] }>(api, "get", "/v1/action-runs")).runs.map((row) => row.runId))
    .toEqual(savedRuns.runs.map((row) => row.runId));
  expect(app.external.calls.filter((call) => call.path === "/model")).toEqual([]);
});
