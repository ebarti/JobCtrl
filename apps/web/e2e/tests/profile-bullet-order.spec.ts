import { test, expect } from "@playwright/test";
import { checkA11y, injectAxe } from "axe-playwright";

const bullets = [
  "Reduced deployment time 40%.",
  "Led platform reliability work.",
  "Mentored service owners.",
] as const;

test.skip(process.env["JOBCTRL_E2E_ISOLATED"] !== "1", "Requires the owned, no-subprocess API fixture");

for (const viewport of ["desktop", "@mobile"]) {
  test(`Profile bullet ordering preserves evidence and required status through autosave, reload, and preview ${viewport}`, async ({ page, baseURL }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const originalResponse = await page.request.get("/v1/profile");
    expect(originalResponse.ok()).toBe(true);
    const original = await originalResponse.json();
    const fixture = structuredClone(original.profile);
    const entry = fixture.resume.experience_entries[0];
    const entryId = entry.id;
    const headers = { origin: new URL(baseURL!).origin, "sec-fetch-site": "same-origin" };
    entry.bullets = bullets;
    entry.achievement_evidence = [];
    fixture.resume.tailoring_rules.required_bullets_by_experience_id[entryId] = [bullets[0]];
    try {
      const seededResponse = await page.request.patch("/v1/profile", { headers, data: { profile: fixture } });
      expect(seededResponse.status(), await seededResponse.text()).toBe(200);
      const seeded = await seededResponse.json();
      const seededEntry = seeded.profile.resume.experience_entries[0];
      const byId = (evidence: Array<{ id: string }>) => [...evidence].sort((left, right) => left.id.localeCompare(right.id));
      const initialEvidence = byId(seededEntry.achievement_evidence);
      expect(initialEvidence).toHaveLength(3);

      await page.goto("/profile");
      await expect(page).toHaveTitle(/JobCtrl.*Profile/);
      await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
      await page.getByRole("button", { name: /^Experience entries\b/ }).click();
      const experience = page.locator(".experience-repeat-section").first();
      await expect(experience.getByRole("button", { name: "Move bullet 1 up", exact: true })).toBeDisabled();
      await expect(experience.getByRole("button", { name: "Move bullet 3 down", exact: true })).toBeDisabled();
      await experience.getByRole("button", { name: "Move bullet 3 up", exact: true }).click();
      await experience.getByRole("button", { name: "Move bullet 1 down", exact: true }).click();
      await expect(experience.getByRole("button", { name: "Move bullet 2 down", exact: true })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(experience.getByRole("textbox", { name: "Bullet 3", exact: true })).toBeFocused();

      const reordered = [bullets[2], bullets[1], bullets[0]];
      await expect.poll(async () => {
        const response = await page.request.get("/v1/profile");
        return (await response.json()).profile.resume.experience_entries[0].bullets;
      }, { timeout: 15_000 }).toEqual(reordered);
      await expect(page.getByRole("button", { name: "Save changes", exact: true })).toHaveCount(0);
      const saved = await (await page.request.get("/v1/profile")).json();
      expect(byId(saved.profile.resume.experience_entries[0].achievement_evidence)).toEqual(initialEvidence);
      expect(saved.profile.resume.tailoring_rules.required_bullets_by_experience_id)
        .toEqual(seeded.profile.resume.tailoring_rules.required_bullets_by_experience_id);
      expect(saved.profile.resume.experience_entries.slice(1)).toEqual(seeded.profile.resume.experience_entries.slice(1));

      await page.reload();
      await page.getByRole("button", { name: /^Experience entries\b/ }).click();
      for (const [index, bullet] of reordered.entries()) {
        await expect(experience.getByRole("textbox", { name: `Bullet ${index + 1}`, exact: true })).toHaveValue(bullet);
      }
      await expect(experience.locator(".bullet-row").nth(2).getByRole("checkbox", { name: "Required", exact: true })).toBeChecked();
      await expect(experience.locator(".bullet-row").nth(0).getByRole("checkbox", { name: "Required", exact: true })).not.toBeChecked();
      await expect(page.locator("vite-error-overlay")).toHaveCount(0);
      await injectAxe(page);
      await checkA11y(page, ".profile-disclosure--experience .bullet-list", {
        axeOptions: { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } },
      });
      await experience.locator(".bullet-list").screenshot({ path: testInfo.outputPath("bullet-order.png") });
      expect(await experience.locator(".bullet-list").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

      await page.getByRole("button", { name: "Resume editor", exact: true }).click();
      await expect(page.locator(`.profile-resume-plate-editor [data-resume-profile-field^="experience:${entryId}:bullet:"]`))
        .toHaveText(reordered, { timeout: 30_000 });
      expect(errors).toEqual([]);
    } finally {
      const restored = await page.request.patch("/v1/profile", { headers, data: { profile: original.profile } });
      expect(restored.status(), await restored.text()).toBe(200);
    }
  });
}
