import { expect, test } from "@playwright/test";
import { ProfileSchema } from "@jobctrl/contracts";
import { refreshE2eWorkerHeartbeat } from "../fixtures/e2e-state.js";

test.skip(process.env["JOBCTRL_E2E_ISOLATED"] !== "1", "Profile mutation QA requires an owned isolated workspace.");
test.beforeEach(() => refreshE2eWorkerHeartbeat());

test("experience defaults preserve all roles until the user explicitly makes one optional", async ({ page, baseURL }, testInfo) => {
  const headers = { origin: new URL(baseURL!).origin, "sec-fetch-site": "same-origin" };
  const beforeResponse = await page.request.get("/v1/profile");
  expect(beforeResponse.ok()).toBe(true);
  const before = await beforeResponse.json();
  const baseline = ProfileSchema.parse(before.profile);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  try {
    const fixture = structuredClone(baseline);
    fixture.resume.experience_entries.push({
      id: "default-optional-peer", title: "Synthetic peer role", company: "Synthetic peer employer",
      date_range: "", location: "", summary: "", bullets: ["Delivered synthetic peer work."], achievement_evidence: [],
    });
    fixture.resume.tailoring_rules.required_experience_entry_ids = [];
    const seeded = await page.request.patch("/v1/profile", { headers, data: { profile: fixture, expectedProfileVersion: before.profileVersion } });
    expect(seeded.ok()).toBe(true);
    await page.goto("/profile");
    await expect(page).toHaveTitle(/Profile/);
    const toggle = page.getByRole("button", { name: /^Experience entries\b/ });
    if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
    const entries = page.locator(".experience-repeat-section");
    await expect(entries).toHaveCount(fixture.resume.experience_entries.length);
    for (const entry of await entries.all()) {
      await expect(entry.getByRole("checkbox", { name: "Must appear in final resume", exact: true })).toBeChecked();
    }
    await entries.last().getByRole("checkbox", { name: "Must appear in final resume", exact: true }).uncheck();
    for (let index = 0; index < baseline.resume.experience_entries.length; index += 1) {
      await expect(entries.nth(index).getByRole("checkbox", { name: "Must appear in final resume", exact: true })).toBeChecked();
    }
    // Exercise add/remove before the saved addition: no deleted-role pin may survive.
    await page.getByRole("button", { name: "Add experience", exact: true }).click();
    await entries.last().getByRole("button", { name: "Remove experience", exact: true }).click();
    await page.getByRole("button", { name: "Add experience", exact: true }).click();
    const added = entries.last();
    await added.getByLabel("Title", { exact: true }).fill("New included role");
    await added.getByLabel("Company", { exact: true }).fill("New synthetic employer");
    await added.getByRole("textbox", { name: "Bullet 1", exact: true }).fill("Delivered a new synthetic service.");
    await expect(added.getByRole("checkbox", { name: "Must appear in final resume", exact: true })).toBeChecked();
    const saving = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === "/v1/profile");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    expect((await saving).ok()).toBe(true);
    await expect(page.getByRole("button", { name: "Save changes", exact: true })).toHaveCount(0);
    const readback = await page.request.get("/v1/profile");
    expect(readback.ok()).toBe(true);
    const saved = ProfileSchema.parse((await readback.json()).profile);
    const newRole = saved.resume.experience_entries.at(-1)!;
    expect(saved.resume.tailoring_rules.required_experience_entry_ids).toEqual([
      ...baseline.resume.experience_entries.map((entry) => entry.id), newRole.id,
    ]);
    const expected = structuredClone(fixture);
    expected.resume.experience_entries.push(newRole);
    expected.resume.tailoring_rules.required_experience_entry_ids = saved.resume.tailoring_rules.required_experience_entry_ids;
    expect(saved).toEqual(expected);
    expect(errors).toEqual([]);
    await added.scrollIntoViewIfNeeded();
    const screenshot = testInfo.outputPath("saved-experience-defaults.png");
    await page.screenshot({ path: screenshot });
    await testInfo.attach("saved-experience-defaults", { path: screenshot, contentType: "image/png" });
  } finally {
    const currentResponse = await page.request.get("/v1/profile");
    expect(currentResponse.ok()).toBe(true);
    const current = await currentResponse.json();
    const restored = await page.request.patch("/v1/profile", { headers, data: { profile: baseline, expectedProfileVersion: current.profileVersion } });
    expect(restored.ok()).toBe(true);
  }
});
