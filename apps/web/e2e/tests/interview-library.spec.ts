import { expect, test } from "@playwright/test";
import { checkA11y, injectAxe } from "axe-playwright";
import Database from "better-sqlite3";
import { makeQuestionPrep } from "../../src/test/fixtures/interviews.js";
import { loadE2eDbPath, QA_PLATFORM_JOB_ID, refreshE2eWorkerHeartbeat } from "../fixtures/e2e-state.js";

let originalProfile: { personal_preferred_name: string; version: number; updated_at: string };
let originalPrepProjection: string | null;
test.beforeAll(() => {
  const db = new Database(loadE2eDbPath());
  try {
    originalProfile = db.prepare("SELECT personal_preferred_name, version, updated_at FROM candidate_profiles WHERE tenant_id='local' AND profile_id='default'").get() as typeof originalProfile;
    originalPrepProjection = (db.prepare("SELECT interview_prep_json FROM job_detail_projections WHERE tenant_id='local' AND job_id=?").get(QA_PLATFORM_JOB_ID) as { interview_prep_json: string | null } | undefined)?.interview_prep_json ?? null;
  }
  finally { db.close(); }
});
test.afterAll(() => {
  const db = new Database(loadE2eDbPath());
  try {
    db.transaction(() => {
      db.prepare("UPDATE candidate_profiles SET personal_preferred_name=?, version=?, updated_at=? WHERE tenant_id='local' AND profile_id='default'").run(originalProfile.personal_preferred_name, originalProfile.version, originalProfile.updated_at);
      db.prepare("DELETE FROM job_interview_prep_items WHERE tenant_id='local' AND job_id=? AND generation BETWEEN 1000 AND 1021").run(QA_PLATFORM_JOB_ID);
      db.prepare("DELETE FROM job_interview_prep WHERE tenant_id='local' AND job_id=? AND generation BETWEEN 1000 AND 1021").run(QA_PLATFORM_JOB_ID);
      db.prepare("DELETE FROM job_interview_note_revisions WHERE tenant_id='local' AND job_id=? AND question_id IN ('B11','TS09','C08','OLD01')").run(QA_PLATFORM_JOB_ID);
      db.prepare("DELETE FROM job_interview_notes WHERE tenant_id='local' AND job_id=? AND question_id IN ('B11','TS09','C08','OLD01')").run(QA_PLATFORM_JOB_ID);
      db.prepare("UPDATE job_detail_projections SET interview_prep_json=? WHERE tenant_id='local' AND job_id=?").run(originalPrepProjection, QA_PLATFORM_JOB_ID);
    })();
  } finally { db.close(); }
});

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

function seedHistoricalPreparation(generation = 1001): void {
  const prep = makeQuestionPrep("B11", QA_PLATFORM_JOB_ID);
  const db = new Database(loadE2eDbPath());
  try {
    const profile = db.prepare("SELECT version FROM candidate_profiles WHERE tenant_id='local' AND profile_id='default'").get() as { version: number };
    prep.generationContext!.profile = { ...prep.generationContext!.profile, profileId: "default", version: profile.version };
    const insert = db.prepare(`INSERT INTO job_interview_prep
      (tenant_id, job_id, generation, status, model, generated_at, gate_status,
       fabrication_findings_json, grounding_findings_json, judge_verdict, warnings_json, failure_reason, generation_context_json)
      VALUES ('local', ?, ?, ?, 'e2e-fixture', '2026-10-01T12:00:00Z', ?, '[]', '[]', 'grounded', '[]', '', ?)
      ON CONFLICT(tenant_id, job_id, generation) DO UPDATE SET status=excluded.status, generation_context_json=excluded.generation_context_json`);
    db.transaction(() => {
      insert.run(QA_PLATFORM_JOB_ID, 1000, "superseded", "passed", null);
      if (generation === 1003) db.prepare("UPDATE job_interview_prep SET status='superseded' WHERE tenant_id='local' AND job_id=? AND generation=1001").run(QA_PLATFORM_JOB_ID);
      insert.run(QA_PLATFORM_JOB_ID, generation, "accepted", "passed", JSON.stringify(prep.generationContext));
      if (generation === 1001) {
        for (let failed = 1002; failed <= 1021; failed += 1) insert.run(QA_PLATFORM_JOB_ID, failed, "failed", "failed", null);
        db.prepare("DELETE FROM job_interview_note_revisions WHERE tenant_id='local' AND job_id=? AND question_id='B11'").run(QA_PLATFORM_JOB_ID);
        db.prepare("DELETE FROM job_interview_notes WHERE tenant_id='local' AND job_id=? AND question_id='B11'").run(QA_PLATFORM_JOB_ID);
      }
      db.prepare("UPDATE job_detail_projections SET interview_prep_json=NULL WHERE tenant_id='local' AND job_id=?").run(QA_PLATFORM_JOB_ID);
      const item = prep.items[0]!;
      db.prepare(`INSERT INTO job_interview_prep_items
        (tenant_id, job_id, generation, item_id, kind, title, generated_text, evidence_ids_json,
         requirement_ids_json, source_text_json, transform_type, control, grounding_audit_json, warnings_json, position, question_metadata_json)
        VALUES ('local', ?, ?, ?, 'question_outline', ?, ?, '[]', '[]', '[]', 'grounded_prep', 'never_fabricate', '[]', '[]', 0, ?)`)
        .run(QA_PLATFORM_JOB_ID, generation, item.itemId, item.title, item.generatedText, JSON.stringify(item.questionMetadata));
    })();
  } finally { db.close(); }
}

test("Interview history: accepted outlines and gaps survive failed runs and independent note revisions", async ({ page }) => {
  test.setTimeout(60_000);
  seedHistoricalPreparation();
  const [jobRead] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === `/v1/jobs/${QA_PLATFORM_JOB_ID}` && response.request().method() === "GET"),
    page.goto(`/interviews?card=B11&job=${QA_PLATFORM_JOB_ID}`),
  ]);
  expect(await jobRead.json()).toMatchObject({ interviewPrep: { generation: 1001, status: "accepted" } });
  const accepted = page.getByRole("region", { name: "Interview preparation", exact: true }).first();
  await expect(accepted.getByText("What did you personally own?", { exact: true })).toBeVisible();
  await expect(accepted).toContainText("generation 1001");
  await expect(accepted.getByRole("paragraph").filter({ hasText: "Open B11 guidance · principle answer" })).toBeVisible();
  await expect(accepted.getByText("Preparation inputs have changed", { exact: true })).toBeVisible();
  await expect(accepted).not.toContainText("profile changed");
  const origin = new URL(page.url()).origin;
  const profileResponse = await page.request.get("/v1/profile");
  const profile = await profileResponse.json();
  const profileUpdate = await page.request.patch("/v1/profile", { headers: { Origin: origin, "sec-fetch-site": "same-origin" }, data: { profile: { ...profile.profile, personal: { ...profile.profile.personal, preferred_name: "Synthetic QA preparation staleness" } } } });
  expect(profileUpdate.status()).toBe(200);
  await expect(accepted).toContainText("profile changed", { timeout: 15_000 });
  await accepted.getByText("Generation-time inputs and versions", { exact: true }).click();
  await expect(accepted).toContainText('"evidenceSelectionMode": "deterministic"');
  const failedAttempt = page.getByText(/Generation 1002 · failed/);
  await failedAttempt.click();
  await expect(failedAttempt.locator("..").getByText("Failed attempt; the accepted generation remains available.")).toBeVisible();
  await expect(accepted.getByText("What did you personally own?", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Older generations" }).click();
  await expect(accepted).toContainText("generation 1001");
  await page.getByText(/Generation 1000 · superseded/).click();
  await expect(page.getByText("Legacy generation: profile, catalog and question versions were not recorded.")).toBeVisible();
  await page.getByRole("navigation", { name: "Interview questions" }).getByRole("link", { name: /TS09/ }).click();
  await page.getByRole("textbox", { name: "Notes for TS09" }).fill("Independent note for a question absent from the saved preparation.");
  const [independent] = await Promise.all([
    page.waitForResponse((response) => response.url().includes("/interview-notes") && response.request().method() === "POST"),
    page.getByRole("button", { name: "Save unverified note" }).click(),
  ]);
  expect(independent.status()).toBe(200);
  expect(independent.request().postDataJSON()).toMatchObject({ questionId: "TS09", sourceGeneration: null, bindings: { contextDigest: null } });
  expect(await independent.json()).toMatchObject({ note: { questionId: "TS09", sourceGeneration: null, bindings: { contextDigest: null }, factualSupport: "unverified_user_statement" } });
  await page.getByRole("navigation", { name: "Interview questions" }).getByRole("link", { name: /B11/ }).click();
  const notes = page.getByRole("textbox", { name: "Notes for B11" });
  await expect(notes).toHaveValue("");
  await notes.fill("Independent synthetic note kept across preparation replacement.");
  const [saved] = await Promise.all([
    page.waitForResponse((response) => response.url().includes("/interview-notes") && response.request().method() === "POST"),
    page.getByRole("button", { name: "Save unverified note" }).click(),
  ]);
  expect(await saved.json()).toMatchObject({ note: { revision: 1, sourceGeneration: 1001, factualSupport: "unverified_user_statement" } });
  seedHistoricalPreparation(1003);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Notes for B11" })).toHaveValue("Independent synthetic note kept across preparation replacement.");
  await expect(page.getByRole("region", { name: "Interview preparation", exact: true }).first()).toContainText("generation 1003");
  await notes.fill("Retained note origin after preparation replacement.");
  const [historical] = await Promise.all([
    page.waitForResponse((response) => response.url().includes("/interview-notes") && response.request().method() === "POST"),
    page.getByRole("button", { name: "Save unverified note" }).click(),
  ]);
  expect(historical.request().postDataJSON()).not.toHaveProperty("sourceGeneration");
  expect(historical.request().postDataJSON()).not.toHaveProperty("bindings");
  expect(await historical.json()).toMatchObject({ note: { revision: 2, sourceGeneration: 1001 } });
  const db = new Database(loadE2eDbPath());
  try {
    db.prepare("DELETE FROM job_interview_prep_items WHERE tenant_id='local' AND job_id=? AND generation=1001").run(QA_PLATFORM_JOB_ID);
    db.prepare("DELETE FROM job_interview_prep WHERE tenant_id='local' AND job_id=? AND generation=1001").run(QA_PLATFORM_JOB_ID);
  } finally { db.close(); }
  await notes.fill("Independent edit after its original preparation became unavailable.");
  const [orphan] = await Promise.all([
    page.waitForResponse((response) => response.url().includes("/interview-notes") && response.request().method() === "POST"),
    page.getByRole("button", { name: "Save unverified note" }).click(),
  ]);
  expect(orphan.status()).toBe(200);
  expect(await orphan.json()).toMatchObject({ note: { revision: 3, sourceGeneration: null, bindings: { contextDigest: null } } });
  await expect(notes).toHaveValue("Independent edit after its original preparation became unavailable.");
  await expect(page.getByRole("region", { name: "Interview preparation", exact: true }).first()).toContainText("generation 1003");
  await page.getByText("Saved note revision history", { exact: true }).click();
  await expect(page.getByText("Source preparation generation: 1001", { exact: true }).first()).toBeVisible();
  await injectAxe(page);
  await checkA11y(page, undefined, { includedImpacts: ["critical", "serious"] });
});

test("Interview notes: retired and unknown questions keep existing notes editable without generation", async ({ page }) => {
  const db = new Database(loadE2eDbPath());
  try {
    db.transaction(() => {
      for (const questionId of ["C08", "OLD01"]) {
        db.prepare(`INSERT INTO job_interview_notes
          (tenant_id, job_id, question_id, revision, note_text, factual_support, edit_status, source_generation, bindings_json, updated_at)
          VALUES ('local', ?, ?, 1, 'Retained synthetic unavailable-question note', 'unverified_user_statement', 'user_edited', NULL, NULL, '2026-10-01T12:00:00Z')`)
          .run(QA_PLATFORM_JOB_ID, questionId);
        db.prepare(`INSERT INTO job_interview_note_revisions
          SELECT * FROM job_interview_notes WHERE tenant_id='local' AND job_id=? AND question_id=?`)
          .run(QA_PLATFORM_JOB_ID, questionId);
      }
    })();
  } finally { db.close(); }
  const generationRequests: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/actions/generate-interview-prep")) generationRequests.push(request.url()); });
  for (const questionId of ["C08", "OLD01"]) {
    await page.goto(`/interviews?card=${questionId}&job=${QA_PLATFORM_JOB_ID}`);
    const notes = page.getByRole("textbox", { name: `Notes for ${questionId}` });
    await expect(notes).toHaveValue("Retained synthetic unavailable-question note");
    await expect(page.getByRole("button", { name: "Add question to preparation" })).toHaveCount(0);
    await notes.fill(`Edited synthetic note for ${questionId}`);
    const [saved] = await Promise.all([
      page.waitForResponse((response) => response.url().includes("/interview-notes") && response.request().method() === "POST"),
      page.getByRole("button", { name: "Save unverified note" }).click(),
    ]);
    expect(saved.status()).toBe(200);
    expect(saved.request().postDataJSON()).not.toHaveProperty("sourceGeneration");
    expect(saved.request().postDataJSON()).not.toHaveProperty("bindings");
    expect(await saved.json()).toMatchObject({ note: { questionId, revision: 2, sourceGeneration: null, bindings: null, factualSupport: "unverified_user_statement" } });
    await expect(notes).toHaveValue(`Edited synthetic note for ${questionId}`);
  }
  expect(generationRequests).toEqual([]);
  await injectAxe(page);
  await checkA11y(page, undefined, { includedImpacts: ["critical", "serious"] });
});
