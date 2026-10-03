import { expect, test } from "@playwright/test";
import { checkA11y, injectAxe } from "axe-playwright";
import type { Locator } from "@playwright/test";
import { sampleInterviewCatalogResponse } from "../../src/test/fixtures/interviews.js";

const catalog = sampleInterviewCatalogResponse.catalog;

async function expectUnobstructedGraph(map: Locator) {
  const defects = await map.evaluate((element) => {
    const errors: string[] = [];
    for (const cluster of element.querySelectorAll(".interview-atlas__cluster")) {
      const hub = cluster.querySelector<HTMLButtonElement>(".interview-atlas__hub")!;
      const satellites = Array.from(cluster.querySelectorAll<HTMLButtonElement>(".interview-atlas__satellite")).filter((button) => getComputedStyle(button).display !== "none");
      const targets = [hub, ...satellites];
      const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right - .1 && a.right > b.left + .1 && a.top < b.bottom - .1 && a.bottom > b.top + .1;
      for (let index = 0; index < targets.length; index++) {
        for (const other of targets.slice(index + 1)) {
          if (overlaps(targets[index]!.getBoundingClientRect(), other.getBoundingClientRect())) errors.push(`Target collision: ${targets[index]!.getAttribute("aria-label")} / ${other.getAttribute("aria-label")}`);
        }
      }
      const mark = hub.querySelector(".interview-atlas__mark")!;
      if (satellites.some((satellite) => overlaps(mark.getBoundingClientRect(), satellite.getBoundingClientRect()))) errors.push(`Covered hub mark: ${hub.getAttribute("aria-label")}`);
      const labels = Array.from(hub.children).filter((child) => !child.classList.contains("interview-atlas__mark"));
      for (const label of labels) {
        const a = label.getBoundingClientRect();
        for (const satellite of satellites) {
          const b = satellite.getBoundingClientRect();
          if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) errors.push(`Label collision: ${hub.getAttribute("aria-label")} / ${satellite.getAttribute("aria-label")}`);
        }
      }
      for (const button of [hub, ...satellites]) {
        button.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
        const rect = button.getBoundingClientRect();
        if (document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest("button") !== button) errors.push(`Covered centre: ${button.getAttribute("aria-label")}`);
      }
    }
    return errors;
  });
  expect(defects).toEqual([]);
}

test("Interview atlas hub labels and native targets survive desktop widths and density", async ({ page }) => {
  for (const width of [1280, 1705]) {
    await page.setViewportSize({ width, height: width === 1280 ? 720 : 1111 });
    await page.goto("/interviews?mode=graph");
    const map = page.getByRole("region", { name: "Whole interview library graph" });
    await expect(map.locator("[data-graph-question-id]")).toHaveCount(121);
    for (const density of ["compact", "regular", "comfy"]) {
      await page.locator(".app-shell").evaluate((element, value) => element.setAttribute("data-density", value), density);
      await expect(map.locator(".interview-atlas__hub").first()).toHaveCSS("height", "64px");
      await expect(map.locator(".interview-atlas__satellite").first()).toHaveCSS("height", "24px");
      await expect(map.locator(".interview-atlas__satellite").first()).toHaveCSS("width", "24px");
      await expectUnobstructedGraph(map);
    }
    await map.getByRole("button", { name: "Behavioral: 11 questions", exact: true }).click();
    await expect(page).toHaveURL(/topic=behavioral/);
    await expect(map.locator(".interview-atlas__named-node")).toHaveCount(11);
    await expect(map.locator(".interview-atlas__named-node").first()).toHaveCSS("min-height", "84px");
    await page.screenshot({ path: `/tmp/jobctrl-993-ui-repair-${width}-topic.png` });
    await map.getByRole("button", { name: "Overview", exact: true }).click();
    await map.getByRole("button", { name: "Sources", exact: true }).click();
    await expect(map.locator("[data-graph-source-id]")).toHaveCount(57);
    await expectUnobstructedGraph(map);
    await page.screenshot({ path: `/tmp/jobctrl-993-ui-repair-${width}-sources.png` });
    await map.getByRole("button", { name: "Will Larson: 21 sources", exact: true }).click();
    await expect(map.locator(".interview-atlas__named-node")).toHaveCount(21);
    await expect(page).not.toHaveURL(/source=L21/);
    await map.getByRole("button", { name: "Overview", exact: true }).click();
    await map.getByRole("button", { name: "Will Larson: 21 sources", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(map.locator(".interview-atlas__named-node")).toHaveCount(21);
    await page.screenshot({ path: `/tmp/jobctrl-993-ui-repair-${width}-author.png` });
    await map.locator(".interview-atlas__named-node").filter({ hasText: "Managing technical quality in a codebase" }).click();
    await expect(page).toHaveURL(/source=L21/);
    const bounded = await page.locator('.interview-library__filters [data-slot="select-trigger"]').evaluateAll((elements) => elements.every((element) => { const rect = element.getBoundingClientRect(); const track = element.parentElement!.getBoundingClientRect(); return rect.left >= track.left && rect.right <= track.right + 1; }));
    expect(bounded).toBe(true);
  }
});

test("Interview atlas overview, topics, sources, history navigation and inspector", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = []; const jobReads: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("request", (request) => { if (/\/v1\/jobs\/[^/?]+(?:\?|$)|generate-interview-prep/.test(request.url())) jobReads.push(request.url()); });
  await page.goto("/interviews?mode=graph");
  await expect(page).toHaveTitle(/Interviews/);
  const map = page.getByRole("region", { name: "Whole interview library graph" });
  await expect(map.locator("[data-graph-question-id]")).toHaveCount(121);
  await expect(map.locator(".interview-atlas__cluster")).toHaveCount(15);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/jobctrl-993-ui-repair-desktop.png" });
  await injectAxe(page); await checkA11y(page, undefined, { includedImpacts: ["critical", "serious"] });
  await map.locator('[data-graph-question-id="B11"]').click();
  await expect(page).toHaveURL(/card=B11/);
  await expect(map.locator("[data-graph-question-id]")).toHaveCount(121);
  await page.getByRole("tab", { name: "Rubric", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Draft answer criteria" })).toBeVisible();
  await page.getByRole("tab", { name: "Sources", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sources and reading limits" })).toBeVisible();
  const topic = catalog.topics[0]!;
  await map.getByRole("button", { name: `${topic.name}: ${topic.questionIds.length} questions` }).click();
  await expect(page).toHaveURL(new RegExp(`topic=${topic.id}`));
  await expect(map.locator(".interview-atlas__named-node")).toHaveCount(topic.questionIds.length);
  await page.goBack(); await expect(map.locator("[data-graph-question-id]")).toHaveCount(121);
  await page.goForward(); await expect(map.locator(".interview-atlas__named-node")).toHaveCount(topic.questionIds.length);
  await map.getByRole("button", { name: "Overview", exact: true }).click();
  await map.getByRole("button", { name: "Sources", exact: true }).click();
  await expect(map.locator("[data-graph-source-id]")).toHaveCount(57);
  await page.screenshot({ path: "/tmp/jobctrl-993-ui-repair-sources.png" });
  await map.locator('[data-graph-source-id="TR02"]').click();
  await expect(page.getByRole("region", { name: "Selected source" })).toContainText("The Staff Engineer's Path");
  await expect(map).toContainText("No linked questions in the current filters.");
  await map.getByRole("button", { name: "Overview", exact: true }).click();
  await map.getByRole("button", { name: "Questions", exact: true }).click();
  await map.getByRole("button", { name: "Zoom in" }).click();
  await expect(map).toContainText("120%");
  await map.getByRole("group", { name: "Interview graph canvas" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(map.locator(".interview-atlas__world")).toHaveCSS("transform", "matrix(1.2, 0, 0, 1.2, -40, 0)");
  await page.keyboard.press("Home"); await expect(map).toContainText("100%");
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Interview questions" }).getByRole("link")).toHaveCount(121);
  await expect(page.locator(".interview-library__toolbar")).toHaveCSS("padding-top", "20px");
  expect(errors).toEqual([]); expect(jobReads).toEqual([]);
});

test("@mobile Interview atlas topic drill-down and readable inspector without overflow", async ({ page }) => {
  await page.goto("/interviews?mode=graph");
  const map = page.getByRole("region", { name: "Whole interview library graph" });
  await expect(map.locator(".interview-atlas__cluster")).toHaveCount(15);
  await expect(map.locator(".interview-atlas__hub").first()).toHaveCSS("height", "96px");
  await page.screenshot({ path: "/tmp/jobctrl-993-ui-repair-mobile.png" });
  const topic = catalog.topics[0]!;
  await map.getByRole("button", { name: `${topic.name}: ${topic.questionIds.length} questions` }).click();
  await expect(map.locator(".interview-atlas__named-node")).toHaveCount(topic.questionIds.length);
  await map.locator(".interview-atlas__named-node").filter({ hasText: "C07" }).click();
  await expect(page).toHaveURL(/card=C07/);
  await page.getByRole("link", { name: "Read selected question ↓" }).click();
  await expect(page.getByRole("heading", { name: "What are your compensation expectations?", exact: true })).toBeInViewport();
  await expect(page.locator(".interview-question-detail")).toContainText(/budgeted range/i);
  await page.screenshot({ path: "/tmp/jobctrl-993-ui-repair-mobile-inspector.png" });
  await injectAxe(page); await checkA11y(page, undefined, { includedImpacts: ["critical", "serious"] });
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const controls = page.locator('.interview-library__filters [data-slot="select-trigger"]');
  expect(await controls.evaluateAll((elements) => elements.every((element) => {
    element.scrollIntoView({ block: "center", behavior: "instant" });
    const rect = element.getBoundingClientRect(); const track = element.parentElement!.getBoundingClientRect();
    const icon = element.querySelector("svg")!.getBoundingClientRect();
    return rect.left >= track.left && rect.right <= track.right + 1 && document.elementFromPoint(icon.x + icon.width / 2, icon.y + icon.height / 2)?.closest('[data-slot="select-trigger"]') === element;
  }))).toBe(true);
  await page.getByRole("combobox", { name: "Answer formats", exact: true }).click();
  await expect(page.getByRole("option", { name: "negotiation", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tab", { name: "Sources", exact: true })).toBeVisible();
});
