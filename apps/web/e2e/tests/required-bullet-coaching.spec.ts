import Database from "better-sqlite3";
import { expect, test, type Page } from "@playwright/test";
import { checkA11y, injectAxe } from "axe-playwright";

import { loadE2eDbPath } from "../fixtures/e2e-state.js";

test.skip(process.env["JOBCTRL_E2E_ISOLATED"] !== "1", "Requires the owned disposable SQLite API fixture");

const originalBullet = "  Helped   with incident response  ";
const cleanedBullet = "Helped with incident response";
const metricBullet = "Reduced synthetic deployment time by 40%.";
const optionalBullet = "Documented synthetic runbooks.";

function profileEventCount(): number {
  const db = new Database(loadE2eDbPath(), { readonly: true });
  try {
    return (db.prepare(
      "SELECT COUNT(*) AS n FROM job_events WHERE event_type = 'ProfileUpdated'",
    ).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

async function seedRequiredBullets(page: Page, baseURL: string) {
  const apiOrigin = `http://127.0.0.1:${process.env["JOBCTRL_E2E_API_PORT"] ?? "8767"}`;
  expect(new URL(baseURL).port).toBe(process.env["JOBCTRL_E2E_WEB_PORT"] ?? "5174");
  const initialResponse = await page.request.get(`${apiOrigin}/v1/profile`);
  expect(initialResponse.status(), await initialResponse.text()).toBe(200);
  const initial = await initialResponse.json();
  const profile = structuredClone(initial.profile);
  const entry = profile.resume.experience_entries[0];
  const entryId = entry.id as string;
  entry.bullets = [originalBullet, metricBullet, optionalBullet];
  entry.achievement_evidence = [
    {
      id: "qa-required-incomplete",
      source_text: cleanedBullet,
      scope: "Synthetic incident response",
      action: cleanedBullet,
      tools: [],
      metrics: [],
      outcome: cleanedBullet,
      seniority_signal: "",
      evidence_strength: "supported",
      claim_confidence: 0.8,
      user_confirmed: true,
      tags: [],
    },
    {
      id: "qa-required-metric",
      source_text: metricBullet,
      scope: "Synthetic deployment",
      action: "Reduced synthetic deployment time",
      tools: [],
      metrics: ["40%"],
      outcome: "Reduced synthetic deployment time by 40%.",
      seniority_signal: "",
      evidence_strength: "verified",
      claim_confidence: 1,
      user_confirmed: true,
      tags: [],
    },
  ];
  profile.resume.tailoring_rules.required_bullets_by_experience_id = {
    [entryId]: [originalBullet, metricBullet],
  };
  const savedResponse = await page.request.patch(`${apiOrigin}/v1/profile`, {
    headers: { origin: new URL(baseURL).origin, "sec-fetch-site": "same-origin" },
    data: { profile, expectedProfileVersion: initial.profileVersion },
  });
  expect(savedResponse.status(), await savedResponse.text()).toBe(200);
  const saved = await savedResponse.json();
  return { apiOrigin, entryId, saved };
}

function inspectionResponse(response: { url(): string; request(): { method(): string } }) {
  return new URL(response.url()).pathname === "/v1/profile/required-bullet-suggestions"
    && response.request().method() === "POST";
}

test("Required coaching inspects saved sources, rejects without writes, and accepts one edit through reload @mobile", async ({ page, baseURL }, testInfo) => {
  const { apiOrigin, entryId, saved } = await seedRequiredBullets(page, baseURL!);
  const eventCount = profileEventCount();
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();

  const generation = page.waitForResponse(inspectionResponse);
  await page.getByRole("button", { name: "Inspect Required bullets" }).click();
  const generatedResponse = await generation;
  expect(generatedResponse.status(), await generatedResponse.text()).toBe(200);
  const generated = await generatedResponse.json();
  expect(generated).toMatchObject({
    profileVersion: saved.profileVersion,
    strategy: "deterministic_rules_v1",
    modelUsed: false,
    truncated: false,
  });
  expect(generated.suggestions.some((item: { originalText: string }) => item.originalText === optionalBullet)).toBe(false);
  expect(generated.suggestions.some((item: { originalText: string }) => item.originalText === metricBullet)).toBe(false);
  const grammar = generated.suggestions.find((item: { kind: string }) => item.kind === "grammar");
  expect(grammar).toMatchObject({
    originalText: originalBullet,
    proposedText: cleanedBullet,
    canApply: true,
    source: {
      sourceId: "qa-required-incomplete",
      identityKind: "canonical_achievement",
      excerpt: originalBullet,
      fieldPath: "profile.resume.experience_entries[0].bullets[0]",
      experienceId: entryId,
      bulletIndex: 0,
      requiredBulletIndex: 0,
    },
  });
  const evidence = generated.suggestions.find((item: { kind: string }) => item.kind === "missing_evidence");
  expect(evidence).toMatchObject({ canApply: false, proposedText: null });
  expect(profileEventCount()).toBe(eventCount);
  expect((await (await page.request.get(`${apiOrigin}/v1/profile`)).json()).profileVersion).toBe(saved.profileVersion);

  const grammarCard = page.locator('[data-slot="card-content"]').filter({ hasText: `Proposed text: “${cleanedBullet}”` });
  await grammarCard.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByText(`Proposed text: “${cleanedBullet}”`)).toHaveCount(0);
  expect(profileEventCount()).toBe(eventCount);

  await page.getByRole("button", { name: "Inspect Required bullets" }).click();
  const saveResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/v1/profile" && response.request().method() === "PATCH",
  );
  await page.locator('[data-slot="card-content"]')
    .filter({ hasText: `Proposed text: “${cleanedBullet}”` })
    .getByRole("button", { name: "Accept" }).click();
  expect((await saveResponse).status()).toBe(200);
  const afterAccept = await (await page.request.get(`${apiOrigin}/v1/profile`)).json();
  expect(afterAccept.profileVersion).toBe(saved.profileVersion + 1);
  expect(profileEventCount()).toBe(eventCount + 1);
  expect(afterAccept.profile.resume.experience_entries[0].bullets).toEqual([
    cleanedBullet, metricBullet, optionalBullet,
  ]);
  expect(afterAccept.profile.resume.tailoring_rules.required_bullets_by_experience_id[entryId])
    .toEqual([cleanedBullet, metricBullet]);
  expect(afterAccept.profile.resume.experience_entries[0].achievement_evidence.map((item: { id: string }) => item.id))
    .toEqual(saved.profile.resume.experience_entries[0].achievement_evidence.map((item: { id: string }) => item.id));
  expect(afterAccept.profile.personal).toEqual(saved.profile.personal);

  await page.reload();
  await page.getByRole("button", { name: /^Experience entries\b/ }).click();
  const experience = page.locator(".experience-repeat-section").first();
  await expect(experience.getByRole("textbox", { name: "Bullet 1", exact: true })).toHaveValue(cleanedBullet);
  await expect(experience.locator(".bullet-row").first().getByRole("checkbox", { name: "Required", exact: true })).toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Inspect Required bullets" })).toBeVisible();
  await injectAxe(page);
  await checkA11y(page, ".profile-data-workspace", {
    axeOptions: { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } },
  });
  await page.screenshot({ path: testInfo.outputPath("required-bullet-mobile.png"), fullPage: true });
  expect(await page.locator(".profile-data-workspace").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
});

test("cleanup is not applicable when its text already belongs to another saved bullet", async ({ page, baseURL }) => {
  const { apiOrigin, saved } = await seedRequiredBullets(page, baseURL!);
  const profile = structuredClone(saved.profile);
  profile.resume.experience_entries[0].bullets[2] = cleanedBullet;
  const updated = await page.request.patch(`${apiOrigin}/v1/profile`, {
    headers: { origin: new URL(baseURL!).origin, "sec-fetch-site": "same-origin" },
    data: { profile, expectedProfileVersion: saved.profileVersion },
  });
  expect(updated.status(), await updated.text()).toBe(200);
  const version = (await updated.json()).profileVersion;
  const eventsBeforeInspection = profileEventCount();

  await page.goto("/profile");
  const response = page.waitForResponse(inspectionResponse);
  await page.getByRole("button", { name: "Inspect Required bullets" }).click();
  const generated = await (await response).json();
  expect(generated.profileVersion).toBe(version);
  expect(generated.suggestions.find((item: { kind: string }) => item.kind === "grammar"))
    .toMatchObject({ originalText: originalBullet, proposedText: null, canApply: false });
  await expect(page.getByText(/Whitespace cleanup would duplicate another saved bullet/)).toBeVisible();
  expect(profileEventCount()).toBe(eventsBeforeInspection);
  expect((await (await page.request.get(`${apiOrigin}/v1/profile`)).json()).profileVersion).toBe(version);
});

test("stale results, version conflicts, and failed requests leave manual edits available", async ({ page, baseURL }) => {
  const { apiOrigin, saved } = await seedRequiredBullets(page, baseURL!);
  await page.goto("/profile");
  let releaseGeneration!: () => void;
  const holdGeneration = new Promise<void>((resolve) => { releaseGeneration = resolve; });
  await page.route("**/v1/profile/required-bullet-suggestions", async (route) => {
    const response = await route.fetch();
    await holdGeneration;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Inspect Required bullets" }).click();
  const name = page.getByRole("textbox", { name: "Full name" });
  await name.fill("Synthetic Pending Draft");
  releaseGeneration();
  await expect(page.getByText(/Save or discard local edits/)).toBeVisible();
  await expect(page.getByText(`Proposed text: “${cleanedBullet}”`)).toHaveCount(0);
  await expect(name).toHaveValue("Synthetic Pending Draft");
  await page.unroute("**/v1/profile/required-bullet-suggestions");

  await page.getByRole("button", { name: "Discard changes" }).click();
  await page.route("**/v1/profile/required-bullet-suggestions", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ ok: false, error: "synthetic_unavailable", message: "Synthetic inspection failure" }),
  }));
  await page.getByRole("button", { name: "Inspect Required bullets" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /Synthetic inspection failure|503/ })).toBeVisible();
  await page.unroute("**/v1/profile/required-bullet-suggestions");
  await page.getByRole("button", { name: "Inspect Required bullets" }).click();
  await expect(page.getByText(`Proposed text: “${cleanedBullet}”`)).toBeVisible();

  let releaseProfileReads!: () => void;
  const holdProfileReads = new Promise<void>((resolve) => { releaseProfileReads = resolve; });
  let releaseStaleSave!: () => void;
  const holdStaleSave = new Promise<void>((resolve) => { releaseStaleSave = resolve; });
  let heldStaleSave = false;
  await page.route("**/v1/profile", async (route) => {
    if (route.request().method() === "GET") {
      await holdProfileReads;
      return route.continue();
    }
    if (route.request().method() === "PATCH" && !heldStaleSave) {
      heldStaleSave = true;
      const response = await route.fetch();
      await holdStaleSave;
      return route.fulfill({ response });
    }
    return route.continue();
  });
  const external = structuredClone(saved.profile);
  external.personal.full_name = "Synthetic External Change";
  const externalResponse = await page.request.patch(`${apiOrigin}/v1/profile`, {
    headers: { origin: new URL(baseURL!).origin, "sec-fetch-site": "same-origin" },
    data: { profile: external, expectedProfileVersion: saved.profileVersion },
  });
  expect(externalResponse.status(), await externalResponse.text()).toBe(200);
  const eventsBeforeStaleAccept = profileEventCount();
  const staleSave = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/v1/profile" && response.request().method() === "PATCH",
  );
  await page.locator('[data-slot="card-content"]')
    .filter({ hasText: `Proposed text: “${cleanedBullet}”` })
    .getByRole("button", { name: "Accept" }).click();
  await expect.poll(() => heldStaleSave).toBe(true);
  const email = page.getByRole("textbox", { name: "Email" });
  await email.fill("synthetic.manual@example.com");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(/Wait for the Required bullet save to finish/)).toBeVisible();
  expect(profileEventCount()).toBe(eventsBeforeStaleAccept);
  releaseStaleSave();
  expect((await staleSave).status()).toBe(409);
  releaseProfileReads();
  await page.unroute("**/v1/profile");
  expect(profileEventCount()).toBe(eventsBeforeStaleAccept);
  const persisted = await (await page.request.get(`${apiOrigin}/v1/profile`)).json();
  expect(persisted.profile.resume.experience_entries[0].bullets[0]).toBe(originalBullet);
  await expect(page.getByText(/manual editing remains available/i)).toBeVisible();
  await expect(email).toHaveValue("synthetic.manual@example.com");
  await page.getByRole("button", { name: "Rebase edits onto saved profile" }).click();
  await expect(email).toHaveValue("synthetic.manual@example.com");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(async () => (await (await page.request.get(`${apiOrigin}/v1/profile`)).json())
    .profile.personal.email).toBe("synthetic.manual@example.com");
  expect((await (await page.request.get(`${apiOrigin}/v1/profile`)).json())
    .profile.resume.experience_entries[0].bullets[0]).toBe(originalBullet);
});

test("a same-bullet manual edit during acceptance keeps its Required pin through save", async ({ page, baseURL }) => {
  const { apiOrigin, entryId } = await seedRequiredBullets(page, baseURL!);
  await page.goto("/profile");
  await page.getByRole("button", { name: "Inspect Required bullets" }).click();
  await expect(page.getByText(`Proposed text: “${cleanedBullet}”`)).toBeVisible();
  let releaseSave!: () => void;
  const holdSave = new Promise<void>((resolve) => { releaseSave = resolve; });
  let didHold = false;
  await page.route("**/v1/profile", async (route) => {
    if (route.request().method() !== "PATCH" || didHold) return route.continue();
    didHold = true;
    const response = await route.fetch();
    await holdSave;
    await route.fulfill({ response });
  });
  await page.locator('[data-slot="card-content"]')
    .filter({ hasText: `Proposed text: “${cleanedBullet}”` })
    .getByRole("button", { name: "Accept" }).click();
  await expect.poll(() => didHold).toBe(true);
  await page.getByRole("button", { name: /^Experience entries\b/ }).click();
  const bullet = page.getByRole("textbox", { name: "Bullet 1", exact: true });
  const manualBullet = "Helped with incident response during synthetic drills.";
  await bullet.fill(manualBullet);
  releaseSave();
  await expect(page.getByText(/manual edit overlaps that Required bullet/)).toBeVisible();
  await expect(bullet).toHaveValue(manualBullet);
  await expect(page.locator(".experience-repeat-section").first().locator(".bullet-row").first()
    .getByRole("checkbox", { name: "Required", exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(async () => (await (await page.request.get(`${apiOrigin}/v1/profile`)).json())
    .profile.resume.experience_entries[0].bullets[0]).toBe(manualBullet);
  const saved = await (await page.request.get(`${apiOrigin}/v1/profile`)).json();
  expect(saved.profile.resume.tailoring_rules.required_bullets_by_experience_id[entryId])
    .toEqual([manualBullet, metricBullet]);
});

test("a committed cleanup with a lost response rebases a different bullet edit", async ({ page, baseURL }) => {
  const { apiOrigin, entryId, saved } = await seedRequiredBullets(page, baseURL!);
  await page.goto("/profile");
  await page.getByRole("button", { name: "Inspect Required bullets" }).click();
  await expect(page.getByText(`Proposed text: “${cleanedBullet}”`)).toBeVisible();

  let releaseResponse!: () => void;
  const holdResponse = new Promise<void>((resolve) => { releaseResponse = resolve; });
  let releaseReads!: () => void;
  const holdReads = new Promise<void>((resolve) => { releaseReads = resolve; });
  let committed = false;
  await page.route("**/v1/profile", async (route) => {
    if (route.request().method() === "GET") {
      await holdReads;
      return route.continue();
    }
    if (route.request().method() === "PATCH" && !committed) {
      const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(200);
      committed = true;
      await holdResponse;
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "synthetic_lost_response", message: "Synthetic response lost after commit" }),
      });
    }
    return route.continue();
  });
  await page.locator('[data-slot="card-content"]')
    .filter({ hasText: `Proposed text: “${cleanedBullet}”` })
    .getByRole("button", { name: "Accept" }).click();
  await expect.poll(() => committed).toBe(true);
  await page.getByRole("button", { name: /^Experience entries\b/ }).click();
  const optional = page.getByRole("textbox", { name: "Bullet 3", exact: true });
  const manualOptional = "Documented synthetic runbooks with a manual revision.";
  await optional.fill(manualOptional);
  releaseResponse();
  await expect(page.getByText(/manual editing remains available/)).toBeVisible();
  releaseReads();
  await page.unroute("**/v1/profile");
  await expect(page.getByRole("button", { name: "Rebase edits onto saved profile" })).toBeVisible();
  await page.getByRole("button", { name: "Rebase edits onto saved profile" }).click();

  await expect(page.getByRole("textbox", { name: "Bullet 1", exact: true })).toHaveValue(cleanedBullet);
  await expect(optional).toHaveValue(manualOptional);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(async () => (await (await page.request.get(`${apiOrigin}/v1/profile`)).json())
    .profile.resume.experience_entries[0].bullets[2]).toBe(manualOptional);
  const persisted = await (await page.request.get(`${apiOrigin}/v1/profile`)).json();
  expect(persisted.profileVersion).toBe(saved.profileVersion + 2);
  expect(persisted.profile.resume.experience_entries[0].bullets)
    .toEqual([cleanedBullet, metricBullet, manualOptional]);
  expect(persisted.profile.resume.tailoring_rules.required_bullets_by_experience_id[entryId])
    .toEqual([cleanedBullet, metricBullet]);
});
