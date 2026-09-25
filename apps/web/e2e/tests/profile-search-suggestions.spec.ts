import Database from "better-sqlite3";
import { test, expect } from "@playwright/test";
import { checkA11y, injectAxe } from "axe-playwright";

import { loadE2eDbPath } from "../fixtures/e2e-state.js";

test.skip(
  process.env["JOBCTRL_E2E_ISOLATED"] !== "1"
    || process.env["JOBCTRL_E2E_PROFILE_SUGGESTIONS"] !== "1",
  "Requires the owned synthetic API with only the real profile suggestion RPC enabled",
);

function profileEventCount(): number {
  const db = new Database(loadE2eDbPath(), { readonly: true });
  try {
    return (db.prepare(
      "SELECT COUNT(*) AS n FROM job_events WHERE event_type = 'ProfileUpdated'",
    ).get() as { n: number }).n;
  } finally { db.close(); }
}

test("Discovery Target search reviews deterministic evidence and saves only explicit preferences", async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const headers = { origin: new URL(baseURL!).origin, "sec-fetch-site": "same-origin" };
  const initial = await (await page.request.get("/v1/profile")).json();
  const profile = structuredClone(initial.profile);
  profile.experience.target_role = "Director of Platform";
  profile.experience.target_track = "Management";
  profile.experience.target_seniority_floor = "Manager";
  profile.experience.target_locations = "Barcelona";
  profile.experience.target_work_models = "Remote";
  profile.resume.experience_entries[0].title = "Platform Engineering Manager";
  profile.resume.experience_entries[0].location = "London | Hybrid";
  const seeded = await page.request.patch("/v1/profile", { headers, data: { profile } });
  expect(seeded.status(), await seeded.text()).toBe(200);
  const seedVersion = (await seeded.json()).profileVersion as number;
  const beforeEvents = profileEventCount();

  await page.goto("/discovery");
  await expect(page).toHaveTitle(/JobCtrl.*Discovery/);
  await expect(page.getByRole("heading", { name: "Discovery", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Suggest roles" })).toBeVisible();
  const responsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/v1/profile/target-role-suggestions",
  );
  await page.getByRole("button", { name: "Suggest roles" }).click();
  const suggestionResponse = await responsePromise;
  expect(suggestionResponse.status(), await suggestionResponse.text()).toBe(200);
  const result = await suggestionResponse.json();
  expect(result).toMatchObject({
    profileVersion: seedVersion,
    strategy: "deterministic",
    preferenceSuggestions: [
      { location: "London", workModel: "Hybrid", evidenceIds: ["experience:qa_platform"] },
    ],
  });
  expect(result.suggestions.slice(0, 2)).toMatchObject([
    { title: "Platform Engineering Manager", classification: "direct" },
    { title: "Platform Reliability Manager", classification: "adjacent" },
  ]);
  expect(profileEventCount()).toBe(beforeEvents);
  expect((await (await page.request.get("/v1/profile")).json()).profileVersion).toBe(seedVersion);
  await expect(page.getByText(/Original suggestion: Platform Engineering Manager/)).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select Platform Engineering Manager" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Select Platform Reliability Manager" })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Add selected roles" })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "Select historical preference 1" })).not.toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Proposed location 1")).toBeVisible();
  await injectAxe(page);
  await checkA11y(page, ".target-search-settings", {
    axeOptions: { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } },
  });

  await page.getByLabel("Suggested role 1").fill("Platform Delivery Manager");
  await page.getByRole("checkbox", { name: "Select Platform Delivery Manager" }).check();
  await expect(page.getByText(/original evidence does not validate your edit/i).first()).toBeVisible();
  await page.getByRole("button", { name: "Reject Platform Reliability Manager" }).click();
  await page.getByRole("button", { name: "Reject Platform Security Manager" }).click();
  await page.getByRole("checkbox", { name: "Select historical preference 1" }).check();
  await page.getByRole("button", { name: "Add selected roles and preferences" }).click();
  await expect(page.getByRole("textbox", { name: "Target roles 1", exact: true })).toHaveValue("Director of Platform");
  await expect(page.getByRole("textbox", { name: "Target roles 2", exact: true })).toHaveValue("Platform Delivery Manager");
  await expect(page.getByRole("textbox", { name: "Target location 1", exact: true })).toHaveValue("Barcelona");
  await expect(page.getByRole("textbox", { name: "Target location 2", exact: true })).toHaveValue("London");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Discovery settings saved")).toBeVisible();
  const saved = await (await page.request.get("/v1/profile")).json();
  expect(saved.profile.experience).toMatchObject({
    target_role: "Director of Platform; Platform Delivery Manager",
    target_locations: "Barcelona; London",
    target_work_models: "Remote; Hybrid",
  });
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Target roles 2", exact: true })).toHaveValue("Platform Delivery Manager");
  await expect(page.getByRole("textbox", { name: "Target location 2", exact: true })).toHaveValue("London");

  await page.getByRole("button", { name: "Suggest roles" }).click();
  await expect(page.getByRole("button", { name: "Add selected roles" })).toBeVisible();
  await page.getByRole("checkbox", { name: "Select Platform Engineering Manager" }).check();
  await page.getByRole("button", { name: "Reject Platform Reliability Manager" }).click();
  await page.getByRole("button", { name: "Reject Platform Security Manager" }).click();
  await page.getByRole("button", { name: "Add selected roles" }).click();
  const externallyChanged = structuredClone(saved.profile);
  externallyChanged.personal.full_name = "External Synthetic Update";
  const external = await page.request.patch("/v1/profile", {
    headers,
    data: { profile: externallyChanged, expectedProfileVersion: saved.profileVersion },
  });
  expect(external.status(), await external.text()).toBe(200);
  const staleSavePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/v1/profile" && response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  expect((await staleSavePromise).status()).toBe(409);
  await expect(page.getByText(/saved profile changed/i).first()).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Target roles 3", exact: true })).toHaveValue("Platform Engineering Manager");
  await page.getByRole("button", { name: "Rebase edits onto saved profile" }).click();
  await expect(page.getByText(/Draft rebased and stale suggestions removed/)).toBeVisible();
  await page.getByRole("button", { name: "Suggest roles" }).click();
  await page.getByRole("button", { name: "Reject Platform Engineering Manager" }).click();
  await page.getByRole("button", { name: "Reject Platform Security Manager" }).click();
  await page.getByRole("checkbox", { name: "Select Platform Reliability Manager" }).check();
  await page.getByRole("button", { name: "Add selected roles" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Discovery settings saved")).toBeVisible();
  await page.reload();
  const final = await (await page.request.get("/v1/profile")).json();
  expect(final.profile.personal.full_name).toBe("External Synthetic Update");
  expect(final.profile.experience.target_role).toContain("Platform Reliability Manager");
  expect(final.profile.experience.target_locations).toBe("Barcelona; London");
  await page.getByRole("button", { name: "Add role", exact: true }).click();
  await page.getByRole("textbox", { name: "Target roles 4", exact: true }).fill("Synthetic Manual Architect");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Discovery settings saved")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Target roles 4", exact: true }))
    .toHaveValue("Synthetic Manual Architect");
  expect(errors.filter((message) => !message.includes("status of 409 (Conflict)"))).toEqual([]);
});
