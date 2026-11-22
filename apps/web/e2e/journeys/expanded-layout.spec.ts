import { randomUUID } from "node:crypto";

import { test, expect, json, modelCall } from "../harness/fixtures.js";
import {
  acceptBaseline, baseline, createBaseline,
} from "./core-data.js";
import { createScoredFit, groupedCoverageDecision } from "./fit-data.js";
import type { Offer } from "./optional-data.js";
import { actionIdentitySnapshot, captureExpanded, visitExpanded } from "./expanded-layout-data.js";

test("Profile peer sections retain readable expanded desktop and mobile layouts without admitting work", async ({ api, app, page }, testInfo) => {
  const authored = structuredClone(baseline);
  authored.resume.language_entries = [{ id: "expanded-language", language: "English", proficiency: "Professional working proficiency" }];
  const seed = await createBaseline(api, authored);
  const achievement = seed.library.roles[0]!.achievements[0]!;
  await json(api, "post", "/v1/profile/wording", {
    expectedProfileVersion: seed.profile.profileVersion,
    achievementId: achievement.achievement_id, sourceRefs: achievement.source_refs,
    text: "Implemented a durable workflow service with a documented recovery and review record.",
  });
  const profileBefore = await json(api, "get", "/v1/profile");
  const wordingBefore = await json(api, "get", "/v1/profile/wording");
  const callsBefore = app.external.calls.filter((call) => call.path === "/model").length;
  const actionsBefore = await actionIdentitySnapshot(api);
  for (const [section, heading] of [
    ["experience", "Experience"], ["skills", "Skills"], ["education", "Education"],
    ["languages", "Languages"], ["personal", "Personal details"], ["resume", "Resume"],
  ] as const) {
    await visitExpanded(page, testInfo, `profile-${section}`, `/profile?section=${section}`, heading);
    if (section === "resume") {
      await page.getByRole("button", { name: "Document and Profile data", exact: true }).click();
      await captureExpanded(page, testInfo, "profile-resume-split", heading);
    }
  }
  expect(app.external.calls.filter((call) => call.path === "/model")).toHaveLength(callsBefore);
  expect(await actionIdentitySnapshot(api)).toEqual(actionsBefore);
  expect(await json(api, "get", "/v1/profile")).toEqual(profileBefore);
  expect(await json(api, "get", "/v1/profile/wording")).toEqual(wordingBefore);
});

test("Settings and search preference tools retain readable expanded desktop and mobile layouts without admitting work", async ({ api, app, page }, testInfo) => {
  await createBaseline(api);
  const profileBefore = await json(api, "get", "/v1/profile");
  const callsBefore = app.external.calls.filter((call) => call.path === "/model").length;
  const actionsBefore = await actionIdentitySnapshot(api);
  for (const [name, path, heading] of [
    ["preferences", "/preferences", "Search preferences"],
    ["connections", "/settings", "Settings"],
    ["budgets", "/settings/budgets", "Settings"],
    ["automation", "/settings/automation", "Settings"],
    ["appearance", "/settings/appearance", "Settings"],
    ["diagnostics", "/settings/data", "Settings"],
  ] as const) await visitExpanded(page, testInfo, name, path, heading);
  expect(app.external.calls.filter((call) => call.path === "/model")).toHaveLength(callsBefore);
  expect(await actionIdentitySnapshot(api)).toEqual(actionsBefore);
  expect(await json(api, "get", "/v1/profile")).toEqual(profileBefore);
});

test("saved Job tabs and Requirements expose their read-only disclosures at desktop and mobile widths", async ({ api, app, page }, testInfo) => {
  const seed = await createScoredFit(api, app, "expanded-job", { twoRequirements: true, sameAchievement: true });
  const achievement = seed.library.roles[0]!.achievements[0]!;
  const coverage = api.post(`/v1/jobs/${seed.posting.job_id}/fit/coverage/refresh`, { data: { prepare_wording: false } });
  const call = await modelCall(app, "fit.wording-coverage-grouped");
  call.reply(groupedCoverageDecision(call, {
    evidenceSourceId: `evidence:${achievement.source_refs[0]!.source_id}`, status: "covered",
    action: "reuse_approved", reusableVariantId: achievement.baseline_variant_id,
  }));
  const covered = await coverage;
  expect(covered.status(), await covered.text()).toBe(200);
  await json(api, "post", "/v1/fit/associations", {
    association_id: randomUUID(), profile_id: "default", expected_profile_revision: seed.profile.profileVersion,
    requirement_id: seed.requirements.requirements[0]!.requirement_id, requirement_revision: 1,
    achievement_id: achievement.achievement_id, achievement_source_refs: achievement.source_refs, wording: null,
  });
  await acceptBaseline(api, seed.posting.job_id, seed.profile.profileVersion);
  await json(api, "post", "/v1/contacts", {
    jobId: seed.posting.job_id, employer: "Synthetic Refresh Company", role: "recruiter",
    attributes: [{ kind: "name", value: "Synthetic Layout Recruiter" }],
  });
  const source = { reference: "synthetic reviewed offer", quote: "EUR 90000 per year", capturedAt: "2026-11-06T12:00:00Z", userConfirmed: true };
  const offer = await json<Offer>(api, "post", `/v1/jobs/${seed.posting.job_id}/offer/terms`, {
    expectedRevisionId: null,
    terms: { source, cash: [{ component: "base_salary", amount: 90000, currency: "EUR", period: "year", source }],
      equity: null, benefits: null, decisionDeadline: null },
  });
  await json(api, "post", `/v1/jobs/${seed.posting.job_id}/offer/decisions`, {
    expectedDecisionId: null, termsRevisionId: offer.currentTerms!.revisionId,
    decision: "accepted", occurredAt: "2026-11-06T12:00:00Z", source,
  });
  const profileBefore = await json(api, "get", "/v1/profile");
  const fitBefore = await json(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`);
  const callsBefore = app.external.calls.filter((item) => item.path === "/model").length;
  const actionsBefore = await actionIdentitySnapshot(api);
  for (const tab of ["fit", "resume", "application", "people", "offer"] as const) {
    await visitExpanded(page, testInfo, `job-${tab}`, `/jobs/${seed.posting.job_id}?jobTab=${tab}`, "Synthetic Reliability Engineer");
    if (tab === "resume") for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const controls = await page.getByRole("main", { name: "Job details", exact: true }).evaluate((workspace) => {
        const bounds = (element: Element) => {
          const box = element.getBoundingClientRect();
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
        };
        return {
          fields: Array.from(workspace.querySelectorAll(".resume-control-field")).map((field) => ({
            label: bounds(field.querySelector(":scope > span")!),
            select: bounds(field.querySelector(":scope > select")!),
            group: bounds(field.closest(".resume-template-assignment-controls, .resume-translation-fields")!),
          })),
          templateField: bounds(workspace.querySelector(".resume-template-assignment-controls > .resume-control-field")!),
          templateAction: bounds(workspace.querySelector(".resume-template-assignment-controls > button")!),
          translationFields: bounds(workspace.querySelector(".resume-translation-fields")!),
          translationActions: bounds(workspace.querySelector(".resume-translation-controls > .resume-control-actions")!),
        };
      });
      await testInfo.attach(`job-resume-controls-${width}-geometry`, { contentType: "application/json", body: JSON.stringify(controls) });
      expect(controls.fields).toHaveLength(3);
      for (const field of controls.fields) {
        expect(field.select.top - field.label.bottom).toBeGreaterThanOrEqual(4);
        expect(field.select.left).toBeGreaterThanOrEqual(field.group.left - 1);
        expect(field.select.right).toBeLessThanOrEqual(field.group.right + 1);
      }
      const templateIntersectionWidth = Math.min(controls.templateField.right, controls.templateAction.right) - Math.max(controls.templateField.left, controls.templateAction.left);
      const templateIntersectionHeight = Math.min(controls.templateField.bottom, controls.templateAction.bottom) - Math.max(controls.templateField.top, controls.templateAction.top);
      expect(templateIntersectionWidth > 1 && templateIntersectionHeight > 1).toBe(false);
      expect(controls.translationActions.top - controls.translationFields.bottom).toBeGreaterThanOrEqual(4);
    }
  }
  // A selected job owns the phone pane. Inspect capture tools through their
  // unselected Jobs route, then restore the selected job before proceeding.
  await visitExpanded(page, testInfo, "jobs-capture", "/jobs", "Jobs");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const capture = await page.getByRole("region", { name: "Add a job", exact: true }).evaluate((panel) => {
      const bounds = (element: Element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      };
      const controls = Array.from(panel.querySelectorAll("label > input, label > textarea")).map(bounds);
      const labelText = Array.from(panel.querySelectorAll("label")).flatMap((label) => Array.from(label.childNodes).flatMap((node) => {
        if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) return [];
        const range = document.createRange();
        range.selectNodeContents(node);
        return Array.from(range.getClientRects()).map((box) => ({ left: box.left, right: box.right, top: box.top, bottom: box.bottom }));
      }));
      const overlaps = (left: typeof controls[number], right: typeof controls[number]) =>
        Math.min(left.right, right.right) - Math.max(left.left, right.left) > 1
        && Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 1;
      return {
        panel: bounds(panel),
        contents: Array.from(panel.querySelectorAll(":scope > h2, form")).map(bounds),
        controlCount: controls.length, labelCount: labelText.length,
        overlappingControls: controls.flatMap((control, index) => controls.slice(index + 1).filter((other) => overlaps(control, other)).map(() => index)),
        overlappingLabels: controls.flatMap((control, index) => labelText.filter((label) => overlaps(control, label)).map(() => index)),
      };
    });
    await testInfo.attach(`job-capture-${width}-geometry`, { contentType: "application/json", body: JSON.stringify(capture) });
    expect(capture.contents).toHaveLength(3);
    for (const content of capture.contents) {
      expect(content.left - capture.panel.left).toBeGreaterThan(1);
      expect(capture.panel.right - content.right).toBeGreaterThan(1);
    }
    expect(capture.controlCount).toBe(6);
    expect(capture.labelCount).toBeGreaterThanOrEqual(6);
    expect(capture.overlappingControls).toEqual([]);
    expect(capture.overlappingLabels).toEqual([]);
  }
  await page.goto(`/jobs/${seed.posting.job_id}?jobTab=application`);
  await expect(page.getByRole("heading", { name: "Synthetic Reliability Engineer", level: 1, exact: true })).toBeVisible();
  await visitExpanded(page, testInfo, "requirement-detail", `/requirements?requirement=${encodeURIComponent(seed.requirements.requirements[0]!.requirement_id)}`, "Requirements library", async () => {
    const detail = page.getByRole("region", { name: "Requirement details", exact: true });
    await detail.getByText("Source history and posting references", { exact: true }).click();
    // The nested provenance disclosure only mounts when posting history arrives.
    await expect(detail.getByText("Current posting reference", { exact: true })).toBeVisible();
  });
  const overflowingDetailText = await page.locator(".requirements-library__detail").evaluate((detail) =>
    Array.from(detail.querySelectorAll<HTMLElement>("p, blockquote, footer, pre")).filter((element) =>
      element.getClientRects().length > 0 && element.scrollWidth > element.clientWidth + 1,
    ).map((element) => ({ tag: element.tagName, text: element.textContent?.trim().slice(0, 120), clientWidth: element.clientWidth, scrollWidth: element.scrollWidth })),
  );
  expect(overflowingDetailText, "Expanded Requirements source IDs and provenance wrap inside their own text containers").toEqual([]);
  expect(app.external.calls.filter((item) => item.path === "/model")).toHaveLength(callsBefore);
  expect(await actionIdentitySnapshot(api)).toEqual(actionsBefore);
  expect(await json(api, "get", "/v1/profile")).toEqual(profileBefore);
  expect(await json(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`)).toEqual(fitBefore);
});

test("interview guidance tabs and both graph perspectives expose readable read-only desktop and mobile layouts", async ({ api, app, page }, testInfo) => {
  await createBaseline(api);
  const profileBefore = await json(api, "get", "/v1/profile");
  const callsBefore = app.external.calls.filter((item) => item.path === "/model").length;
  const actionsBefore = await actionIdentitySnapshot(api);
  await visitExpanded(page, testInfo, "interviews-list-answer", "/interviews?card=B01", "Interviews");
  for (const tab of ["Rubric", "Sources"] as const) {
    await page.getByRole("tablist", { name: "Question inspector", exact: true }).getByRole("tab", { name: tab, exact: true }).click();
    await captureExpanded(page, testInfo, `interviews-${tab.toLowerCase()}`, "Interviews");
  }
  await visitExpanded(page, testInfo, "interviews-graph", "/interviews?mode=graph&card=B01", "Interviews");
  await page.getByRole("group", { name: "Graph perspective", exact: true }).getByRole("button", { name: "Sources", exact: true }).click();
  await captureExpanded(page, testInfo, "interviews-source-graph", "Interviews");
  expect(app.external.calls.filter((item) => item.path === "/model")).toHaveLength(callsBefore);
  expect(await actionIdentitySnapshot(api)).toEqual(actionsBefore);
  expect(await json(api, "get", "/v1/profile")).toEqual(profileBefore);
});

test("Discovery source tools expose every read-only tab and nested disclosure at desktop and mobile widths", async ({ api, app, page }, testInfo) => {
  await createBaseline(api);
  const profileBefore = await json(api, "get", "/v1/profile");
  const callsBefore = app.external.calls.filter((item) => item.path === "/model").length;
  const actionsBefore = await actionIdentitySnapshot(api);
  await visitExpanded(page, testInfo, "discovery", "/discovery", "Search for jobs", async () => {
    await page.getByText("Search plans, schedules and source behavior", { exact: true }).click();
    // The outer disclosure opens before its toggle handler mounts the tools.
    await expect(page.getByText("One-off search with temporary criteria", { exact: true })).toBeVisible();
  });
  await page.getByRole("button", { name: "Manage search sources", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Search sources", exact: true })).toBeVisible();
  for (const tab of ["JobStreaming boards", "Quarantine review", "Role matching", "Manual capture"] as const) {
    await page.getByRole("tablist", { name: "Discovery tools", exact: true }).getByRole("tab", { name: tab, exact: true }).click();
    await captureExpanded(page, testInfo, `discovery-${tab.toLowerCase().replaceAll(" ", "-")}`, "Search for jobs");
  }
  expect(app.external.calls.filter((item) => item.path === "/model")).toHaveLength(callsBefore);
  expect(await actionIdentitySnapshot(api)).toEqual(actionsBefore);
  expect(await json(api, "get", "/v1/profile")).toEqual(profileBefore);
});
