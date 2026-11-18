import { test, expect, json, modelCall } from "../harness/fixtures.js";
import { catalogMatching, typedExtraction } from "./requirements-data.js";

test("the Requirements table filters and sorts the complete library before paging and preserves desktop and mobile detail navigation", async ({ api, app, page }, testInfo) => {
  const clauses = [
    ["Architecture reviews", "Lead architecture reviews for distributed services."],
    ["Budget planning", "Own annual engineering budget planning."],
    ["Capacity planning", "Plan service capacity against demand forecasts."],
    ["Change management", "Coordinate production change management."],
    ["Cloud migrations", "Lead cloud infrastructure migrations."],
    ["Cost optimization", "Reduce recurring infrastructure costs."],
    ["Data governance", "Establish data governance responsibilities."],
    ["Delivery forecasting", "Forecast engineering delivery dates."],
    ["Design reviews", "Facilitate engineering design reviews."],
    ["Disaster recovery", "Exercise disaster recovery procedures."],
    ["Engineering hiring", "Hire engineers through structured interviews."],
    ["Incident command", "Command production incident response."],
    ["Infrastructure automation", "Automate infrastructure provisioning."],
    ["Mentoring", "Mentor engineers through development plans."],
    ["Observability operations", "Operate service observability systems."],
    ["On-call planning", "Plan sustainable on-call rotations."],
    ["Performance analysis", "Investigate application performance bottlenecks."],
    ["Platform roadmaps", "Maintain an internal platform roadmap."],
    ["Privacy engineering", "Apply privacy controls to data pipelines."],
    ["Product discovery", "Partner with product teams on customer discovery."],
    ["Release planning", "Coordinate software release schedules."],
    ["Reliability programs", "Lead a service reliability improvement program."],
    ["Risk assessment", "Assess technical delivery risks."],
    ["Security reviews", "Run application security reviews."],
    ["Service ownership", "Define engineering service ownership."],
    ["Stakeholder reporting", "Report engineering outcomes to stakeholders."],
    ["System integration", "Integrate independently owned software systems."],
    ["Technical strategy", "Set a multi-year engineering strategy."],
    ["Vendor management", "Manage engineering vendor relationships."],
    ["Zig", "Write production tooling with Zig."],
  ] as const;
  const posting = await json<{ job_id: string; revision: number }>(api, "post", "/v1/jobs/capture", {
    url: "https://example.com/jobs/requirements-table",
    title: "Synthetic Requirements Table Lead", company: "Synthetic Table Company",
    description: clauses.map(([, text]) => text).join("\n"),
  });
  const extracting = api.post(`/v1/jobs/${posting.job_id}/requirements`, {
    data: { expected_posting_revision: posting.revision, expected_revision: 0 },
  });
  const extraction = await modelCall(app, "requirements.extract");
  extraction.reply(typedExtraction(extraction, { requirements: clauses.map(([name, text], index) => ({
    localId: `demand-${index + 1}`, name, text, category: name === "Zig" ? "skill" : "professional_experience",
  })) }));
  const matching = await modelCall(app, "requirements.match_catalog");
  matching.reply(catalogMatching(matching, Object.fromEntries(clauses.map((_, index) => [`demand-${index + 1}`, { verdict: "new" as const }]))));
  const acceptedResponse = await extracting;
  expect(acceptedResponse.status(), await acceptedResponse.text()).toBe(200);
  const accepted = await acceptedResponse.json() as { requirements: { requirement_id: string; name: string }[] };
  expect(accepted.requirements).toHaveLength(30);
  const zig = accepted.requirements.find((row) => row.name === "Zig")!;
  const callsBeforeBrowsing = app.external.calls.length;

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/requirements");
  const table = page.getByRole("table", { name: "Saved requirements", exact: true });
  const rows = table.locator("tbody tr[data-row-id]");
  await expect(rows).toHaveCount(25);
  await expect(page.getByRole("region", { name: "Requirement details", exact: true })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("requirement")).toBe(false);
  await expect(rows.first()).toContainText("Architecture reviews");
  await expect(rows.filter({ hasText: "Zig" })).toHaveCount(0);
  const savedView = page.getByRole("combobox", { name: "Saved table view", exact: true });
  await savedView.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(savedView).toBeFocused();
  const focusIndicator = await savedView.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
  });
  expect(focusIndicator.style).not.toBe("none");
  expect(focusIndicator.width).toBeGreaterThanOrEqual(2);

  // The sole Skill is outside the first ascending page. A complete-library
  // filter must still find it, then reset the page before rendering it.
  await page.getByRole("combobox", { name: "Filter a column", exact: true }).selectOption("category");
  const categoryFilter = page.getByRole("dialog", { name: "Category filter", exact: true });
  await categoryFilter.getByRole("checkbox", { name: "Skill", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Zig");
  await expect(page.getByText("Page 1 of 1 · 1 rows", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear all filters", exact: true }).click();
  await expect(rows).toHaveCount(25);

  await table.getByRole("button", { name: "Sort by Requirement (ascending)", exact: true }).click();
  await expect(rows.first()).toContainText("Zig");
  await expect(table.locator("th[data-column-id='name'][scope='col']")).toHaveAttribute("aria-sort", "descending");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(rows).toHaveCount(5);
  const secondPageIds = await rows.evaluateAll((elements) => elements.map((row) => row.getAttribute("data-row-id")));
  const selectedId = secondPageIds[0]!;
  const selectedName = await rows.first().locator(".requirements-table__name").innerText();
  await rows.first().click();
  const detail = page.getByRole("region", { name: "Requirement details", exact: true });
  await expect(detail.getByRole("heading", { name: selectedName, exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("requirement")).toBe(selectedId);
  const tableBounds = await page.locator(".requirements-library__table").boundingBox();
  const detailBounds = await detail.boundingBox();
  expect(tableBounds!.x + tableBounds!.width).toBeLessThanOrEqual(detailBounds!.x);
  const header = page.locator(".requirements-library__table .data-grid-toolbar");
  const titleBounds = (await header.locator(".data-grid-view-title").boundingBox())!;
  const titleTextBounds = (await header.locator(".data-grid-view-title > strong").boundingBox())!;
  const countBounds = (await header.locator(".data-grid-view-title > .meta").boundingBox())!;
  const toolBounds = (await header.locator(".data-grid-tools").boundingBox())!;
  expect(toolBounds.y).toBeGreaterThanOrEqual(titleBounds.y + titleBounds.height);
  expect(titleTextBounds.x + titleTextBounds.width <= countBounds.x + 1
    || titleTextBounds.y + titleTextBounds.height <= countBounds.y + 1).toBe(true);
  expect(titleBounds.x).toBeGreaterThanOrEqual(tableBounds!.x);
  expect(Math.max(titleBounds.x + titleBounds.width, toolBounds.x + toolBounds.width)).toBeLessThanOrEqual(tableBounds!.x + tableBounds!.width);
  await testInfo.attach("requirements-table-desktop", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await page.goBack();
  await expect(detail).toHaveCount(0);
  await expect(rows).toHaveCount(5);
  expect(await rows.evaluateAll((elements) => elements.map((row) => row.getAttribute("data-row-id")))).toEqual(secondPageIds);

  await rows.first().click();
  await detail.locator("summary").filter({ hasText: /^Source history and posting references$/ }).click();
  await detail.getByRole("link", { name: "Open source job", exact: true }).click();
  await expect(page.getByRole("main", { name: "Job details", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to requirements", exact: true }).click();
  await expect(detail.getByRole("heading", { name: selectedName, exact: true })).toBeVisible();
  await expect(page.getByText("Page 2 of 2 · 30 rows", { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("dir")).toBe("desc");
  await detail.getByRole("button", { name: "← Back to requirements", exact: true }).click();

  await page.getByRole("button", { name: "Configure table columns", exact: true }).click();
  const columns = page.getByRole("dialog", { name: "Columns", exact: true });
  await columns.getByRole("checkbox", { name: "Definition", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(table.locator("th[data-column-id='definition'][scope='col']")).toBeVisible();
  await table.getByRole("button", { name: "Reorder Requirement column", exact: true }).press("ArrowRight");
  await expect(table.locator("thead th").first()).toHaveAttribute("data-column-id", "category");
  const widthBefore = await table.locator("col[data-column-id='name']").getAttribute("style");
  await table.getByRole("button", { name: "Resize Requirement column", exact: true }).press("ArrowRight");
  expect(await table.locator("col[data-column-id='name']").getAttribute("style")).not.toBe(widthBefore);

  await page.getByRole("textbox", { name: "Find a requirement", exact: true }).fill("Zig");
  await expect(rows).toHaveCount(1);
  await page.getByRole("button", { name: "Save as view", exact: true }).click();
  const save = page.getByRole("dialog", { name: "Save view", exact: true });
  await save.getByRole("textbox", { name: "Name", exact: true }).fill("Tooling review");
  await save.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Clear all filters", exact: true }).click();
  await expect(rows).toHaveCount(25);
  await page.getByRole("combobox", { name: "Saved table view", exact: true }).click();
  await page.getByRole("option", { name: "Default", exact: true }).click();
  await page.getByRole("combobox", { name: "Saved table view", exact: true }).click();
  await page.getByRole("option", { name: "Tooling review", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(table.locator("thead th").first()).toHaveAttribute("data-column-id", "category");
  await expect(page.getByRole("textbox", { name: "Find a requirement", exact: true })).toHaveValue("Zig");
  await page.reload();
  await expect(rows).toHaveCount(1);
  await expect(table.locator("thead th").first()).toHaveAttribute("data-column-id", "category");

  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = page.getByRole("list", { name: "Saved requirements", exact: true });
  await expect(mobile.locator(".data-grid-mobile-record")).toHaveCount(1);
  await expect(header.locator(".data-grid-view-title > .meta")).toBeVisible();
  const mobileHeaderOverflow = await header.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
  expect(mobileHeaderOverflow).toBe(false);
  await mobile.getByRole("listitem").first().click();
  await expect(detail.getByRole("heading", { name: "Zig", exact: true })).toBeVisible();
  await expect(mobile).not.toBeVisible();
  const disclosureHeights = await detail.locator("summary").evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().height));
  expect(disclosureHeights.length).toBeGreaterThan(0);
  for (const height of disclosureHeights) expect(height).toBeGreaterThanOrEqual(44);
  expect(new URL(page.url()).searchParams.get("requirement")).toBe(zig.requirement_id);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await testInfo.attach("requirements-table-mobile", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await detail.getByRole("button", { name: "← Back to requirements", exact: true }).click();
  await expect(mobile).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Find a requirement", exact: true })).toHaveValue("Zig");
  const mobileActivation = mobile.getByRole("button", { name: "Open Zig: View details", exact: true });
  await expect(mobileActivation).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(mobileActivation).toBeFocused();
  expect((await mobileActivation.boundingBox())!.width).toBeGreaterThan(1);
  await mobileActivation.press("Enter");
  await expect(detail.getByRole("heading", { name: "Zig", exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("requirement")).toBe(zig.requirement_id);
  await detail.getByRole("button", { name: "← Back to requirements", exact: true }).click();
  await expect(mobile).toBeVisible();
  expect(app.external.calls.length).toBe(callsBeforeBrowsing);
});
