import { expect, test } from "@playwright/test";
import { checkA11y, injectAxe } from "axe-playwright";
import { QA_PLATFORM_JOB_ID, refreshE2eWorkerHeartbeat } from "../fixtures/e2e-state.js";

// Repository Playwright workflow: Browser plugin is unavailable in this task.
// These requests exercise the real API against the run's owned synthetic DB.
test("Interview library: all authored guidance without a job, range-first advice and retired card", async ({ page }) => {
  const errors: string[] = [];
  const jobOrProviderRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("request", (request) => { if (/\/v1\/jobs\/[^/?]+(?:\?|$)|generate-interview-prep/.test(request.url())) jobOrProviderRequests.push(request.url()); });
  await page.goto("/interviews?card=B11");
  await expect(page).toHaveTitle(/Interviews/);
  await expect(page.getByRole("heading", { name: "Interviews", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Interview questions" }).getByRole("link")).toHaveCount(121);
  await expect(page.getByRole("heading", { name: "Sources and reading limits" })).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await page.getByRole("button", { name: "Graph", exact: true }).click();
  await expect(page).toHaveURL(/mode=graph/);
  await expect(page.getByRole("region", { name: "Question connections" })).toBeVisible();
  await page.getByRole("textbox", { name: "Search questions" }).fill("C07");
  await expect(page.getByRole("navigation", { name: "Interview questions" }).getByRole("link")).toHaveCount(1);
  await expect(page.locator(".interview-question-detail")).toContainText(/budgeted range/i);
  await expect(page.locator(".interview-question-detail")).toContainText(/persist/i);
  await page.screenshot({ path: "/tmp/jobctrl-993-interview-desktop.png", fullPage: false });
  await injectAxe(page);
  await checkA11y(page, undefined, { includedImpacts: ["critical", "serious"] });
  await page.goto("/interviews?card=C08");
  await expect(page.getByRole("heading", { name: "C08 is retired" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate selected preparation" })).toHaveCount(0);
  expect(jobOrProviderRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test("Interview preparation: ordered evidence choices dispatch and independent CAS notes survive navigation", async ({ page }) => {
  refreshE2eWorkerHeartbeat();
  await page.goto(`/interviews?card=B11&job=${QA_PLATFORM_JOB_ID}`);
  await expect(page.getByRole("link", { name: "Open canonical job" })).toBeVisible();
  const add = page.getByRole("button", { name: "Add question to preparation" });
  if (await add.count()) await add.click();
  await page.getByText("Evidence for B11: automatic selection").click();
  await page.getByRole("button", { name: "Use no evidence for B11" }).click();
  await page.getByRole("textbox", { name: "Known interview criteria (one per line)" }).fill("Explain decision alternatives and tradeoffs");
  const [dispatch] = await Promise.all([
    page.waitForResponse((response) => response.url().includes("/actions/generate-interview-prep") && response.request().method() === "POST"),
    page.getByRole("button", { name: "Generate selected preparation" }).click(),
  ]);
  expect(dispatch.status()).toBe(202);
  expect(dispatch.request().postDataJSON()).toMatchObject({ selectedQuestionIds: ["B11"], evidenceSelections: [{ questionId: "B11", evidenceIds: [] }], interviewStage: "unknown", knownCriteria: ["Explain decision alternatives and tradeoffs"] });
  const notes = page.getByRole("textbox", { name: "Notes for B11" });
  await notes.fill("Synthetic recollection requiring personal verification.");
  const [save] = await Promise.all([
    page.waitForResponse((response) => response.url().includes("/interview-notes") && response.request().method() === "POST"),
    page.getByRole("button", { name: "Save unverified note" }).click(),
  ]);
  expect(save.status()).toBe(200);
  const saved = await save.json();
  expect(saved).toMatchObject({ ok: true, note: { questionId: "B11", factualSupport: "unverified_user_statement", revision: 1 } });
  await expect(page.getByRole("button", { name: "Save unverified note" })).toBeDisabled();
  await page.getByRole("navigation", { name: "Interview questions" }).getByRole("link", { name: /TS09/ }).click();
  await expect(page.getByRole("textbox", { name: "Notes for TS09" })).toHaveValue("");
  await page.getByRole("navigation", { name: "Interview questions" }).getByRole("link", { name: /B11/ }).click();
  await expect(notes).toHaveValue("Synthetic recollection requiring personal verification.");
  const conflict = await page.request.post(`/v1/jobs/${QA_PLATFORM_JOB_ID}/interview-notes`, { headers: { Origin: new URL(page.url()).origin, "sec-fetch-site": "same-origin" }, data: { questionId: "B11", expectedRevision: 0, noteText: "Outdated CAS must fail" } });
  expect(conflict.status()).toBe(409);
  expect(await conflict.json()).toMatchObject({ error: "interview_note_revision_conflict", currentNote: { revision: 1 } });
  await page.getByText("Saved note revision history", { exact: true }).click();
  await expect(page.getByText(/Revision 1 ·/)).toBeVisible();
  await injectAxe(page);
  await checkA11y(page, undefined, { includedImpacts: ["critical", "serious"] });
});

test("Interview library responsive graph preserves touch and keyboard question actions @mobile", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/interviews?card=TS09&mode=graph");
  await expect(page.getByRole("heading", { name: "Interviews", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Question connections" })).toBeVisible();
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page).toHaveURL(/mode=list/);
  const b11 = page.getByRole("navigation", { name: "Interview questions" }).getByRole("link", { name: /B11/ });
  await b11.focus(); await b11.press("Enter");
  await expect(page).toHaveURL(/card=B11/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/jobctrl-993-interview-mobile.png", fullPage: false });
  await injectAxe(page);
  await checkA11y(page, undefined, { includedImpacts: ["critical", "serious"] });
  expect(errors).toEqual([]);
});

test("Interview evidence: accepted canonical choices retain their version until explicit stale-profile review", async ({ page }) => {
  refreshE2eWorkerHeartbeat();
  await page.goto(`/interviews?card=B11&job=${QA_PLATFORM_JOB_ID}`);
  await page.getByRole("button", { name: "Add question to preparation" }).click();
  await page.getByText("Evidence for B11: automatic selection").click();
  const choice = page.getByRole("checkbox", { name: /Use Owned platform reliability improvements for incident response.*for B11/ });
  await expect(choice).toBeVisible();
  await choice.check();
  const [firstDispatch] = await Promise.all([
    page.waitForResponse((response) => response.url().includes("/actions/generate-interview-prep") && response.request().method() === "POST"),
    page.getByRole("button", { name: "Generate selected preparation" }).click(),
  ]);
  expect(firstDispatch.status()).toBe(202);
  const original = firstDispatch.request().postDataJSON();
  expect(original).toMatchObject({ evidenceSelections: [{ questionId: "B11", evidenceIds: ["ev-platform"] }] });
  expect(original.evidenceProfileVersion).toBeGreaterThan(0);
  const origin = new URL(page.url()).origin;
  const current = await page.request.get("/v1/profile");
  const profile = await current.json();
  const updated = await page.request.patch("/v1/profile", { headers: { Origin: origin, "sec-fetch-site": "same-origin" }, data: { profile: { ...profile.profile, personal: { ...profile.profile.personal, preferred_name: "Synthetic QA version review" } } } });
  expect(updated.status()).toBe(200);
  const newer = await updated.json();
  expect(newer.profileVersion).toBeGreaterThan(original.evidenceProfileVersion);
  await expect(page.getByText(new RegExp(`Your choices are retained at version ${original.evidenceProfileVersion}`))).toBeVisible({ timeout: 15_000 });
  await expect(choice).toBeChecked();
  await expect(page.getByRole("button", { name: "Generate selected preparation" })).toBeDisabled();
  const rejected = await page.request.post(`/v1/jobs/${QA_PLATFORM_JOB_ID}/actions/generate-interview-prep`, { headers: { Origin: origin, "sec-fetch-site": "same-origin" }, data: original });
  expect(rejected.status()).toBe(409);
  expect(await rejected.json()).toMatchObject({ error: "evidence_profile_changed" });
  await page.getByRole("button", { name: `Confirm reviewed evidence at Profile version ${newer.profileVersion}` }).click();
  const [reselected] = await Promise.all([
    page.waitForResponse((response) => response.url().includes("/actions/generate-interview-prep") && response.request().method() === "POST"),
    page.getByRole("button", { name: "Generate selected preparation" }).click(),
  ]);
  expect(reselected.status()).toBe(202);
  expect(reselected.request().postDataJSON()).toMatchObject({ evidenceProfileVersion: newer.profileVersion, evidenceSelections: original.evidenceSelections });
  await page.getByRole("region", { name: "Job interview preparation" }).screenshot({ path: "/tmp/jobctrl-993-interview-preparation.png" });
});
