import { expect, test } from "@playwright/test";
import { ProfileSchema } from "@jobctrl/contracts";

import { refreshE2eWorkerHeartbeat } from "../fixtures/e2e-state.js";

test.skip(process.env["JOBCTRL_E2E_ISOLATED"] !== "1", "Profile mutation QA requires an owned isolated workspace.");

test.beforeEach(() => {
  if (process.env["JOBCTRL_E2E_ISOLATED"] === "1") refreshE2eWorkerHeartbeat();
});

test("new profile entries save with stable unique identities and preserved requirements", async ({ page }, testInfo) => {
  const beforeResponse = await page.request.get("/v1/profile");
  expect(beforeResponse.ok()).toBe(true);
  const before = await beforeResponse.json();
  const profileBefore = ProfileSchema.parse(before.profile);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  try {
    await page.goto("/profile");
    await expect(page).toHaveTitle(/Profile/);
    await expect(page.getByRole("heading", { name: "Personal information" })).toBeVisible();

    for (const name of [/^Experience entries\b/, /^Education\b/, /^Skill categories\b/]) {
      const toggle = page.getByRole("button", { name });
      if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
    }

    await page.getByRole("button", { name: "Add experience", exact: true }).click();
    const experience = page.locator(".experience-repeat-section").last();
    await experience.getByLabel("Title", { exact: true }).fill("Synthetic role");
    await experience.getByLabel("Company", { exact: true }).fill("Synthetic employer");
    await experience.getByRole("textbox", { name: "Bullet 1", exact: true }).fill("Delivered a synthetic platform.");
    await experience.getByRole("checkbox", { name: "Must appear in final resume", exact: true }).check();
    await experience.getByLabel("Title", { exact: true }).fill("Renamed synthetic role");

    await page.getByRole("button", { name: "Add education", exact: true }).click();
    const education = page.locator(".profile-disclosure--education .repeat-section").last();
    await education.getByLabel("Degree", { exact: true }).fill("Synthetic degree");
    await education.getByLabel("Institution", { exact: true }).fill("Synthetic institution");
    await education.getByRole("checkbox", { name: "Must appear in final resume", exact: true }).check();

    await page.getByRole("button", { name: "Add skill category", exact: true }).click();
    const cloud = page.locator(".profile-disclosure--skills .repeat-section").last();
    await cloud.getByLabel("Label", { exact: true }).fill("Cloud");
    await cloud.getByLabel("Skill 1", { exact: true }).fill("Kubernetes");
    await cloud.getByRole("checkbox", { name: "Must appear in final resume", exact: true }).check();
    await cloud.getByLabel("Label", { exact: true }).fill("Platform & Cloud");
    await page.getByRole("button", { name: "Add skill category", exact: true }).click();
    const architecture = page.locator(".profile-disclosure--skills .repeat-section").last();
    await architecture.getByLabel("Label", { exact: true }).fill("Architecture");
    await architecture.getByLabel("Skill 1", { exact: true }).fill("Microservices");

    const savedResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH" && new URL(response.url()).pathname === "/v1/profile");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    expect((await savedResponse).ok()).toBe(true);
    await expect(page.getByRole("button", { name: "Save changes", exact: true })).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Profile saved" })).toBeVisible();

    const afterResponse = await page.request.get("/v1/profile");
    expect(afterResponse.ok()).toBe(true);
    const after = await afterResponse.json();
    const saved = ProfileSchema.parse(after.profile);
    const role = saved.resume.experience_entries.at(-1)!;
    const degree = saved.resume.education_entries.at(-1)!;
    const categories = saved.resume.skill_categories.slice(-2);
    const addedIds = [role.id, degree.id, ...categories.map((entry) => entry.id)];
    const originalIds = [
      ...profileBefore.resume.experience_entries,
      ...profileBefore.resume.education_entries,
      ...profileBefore.resume.skill_categories,
    ].map((entry) => entry.id);
    expect(addedIds.every((id) => id.length > 0 && !originalIds.includes(id))).toBe(true);
    expect(new Set(addedIds).size).toBe(4);
    expect(role.title).toBe("Renamed synthetic role");
    expect(role.bullets).toEqual(["Delivered a synthetic platform."]);
    expect(degree.degree).toBe("Synthetic degree");
    expect(categories.map(({ label, items }) => ({ label, items }))).toEqual([
      { label: "Platform & Cloud", items: ["Kubernetes"] },
      { label: "Architecture", items: ["Microservices"] },
    ]);
    const expected = structuredClone(profileBefore);
    expected.resume.experience_entries.push(role);
    expected.resume.education_entries.push(degree);
    expected.resume.skill_categories.push(...categories);
    expected.resume.tailoring_rules.required_experience_entry_ids!.push(role.id);
    expected.resume.tailoring_rules.required_education_entry_ids!.push(degree.id);
    expected.resume.tailoring_rules.required_skill_category_ids!.push(categories[0]!.id);
    expect(saved).toEqual(expected);
    expect(after.profileVersion).toBeGreaterThan(before.profileVersion);
    expect(errors).toEqual([]);
    await architecture.scrollIntoViewIfNeeded();
    const screenshot = testInfo.outputPath("saved-profile-entry-identities.png");
    await page.screenshot({ path: screenshot });
    await testInfo.attach("saved-profile-entry-identities", { path: screenshot, contentType: "image/png" });
  } finally {
    // This run owns the synthetic workspace; leave its shared profile fixture
    // unchanged for other flow specs even when an assertion fails.
    const currentResponse = await page.request.get("/v1/profile");
    expect(currentResponse.ok()).toBe(true);
    const current = await currentResponse.json();
    const restored = await page.request.patch("/v1/profile", { headers: { Origin: new URL(page.url()).origin }, data: {
      profileText: JSON.stringify(before.profile), expectedProfileVersion: current.profileVersion,
    } });
    expect(restored.ok()).toBe(true);
  }
});
