import Database from "better-sqlite3";
import { test, expect } from "@playwright/test";
import { checkA11y, injectAxe } from "axe-playwright";

import { loadE2eDbPath } from "../fixtures/e2e-state.js";

test.skip(
  process.env["JOBCTRL_E2E_ISOLATED"] !== "1"
    || process.env["JOBCTRL_E2E_PROFILE_SUGGESTIONS"] !== "1",
  "Requires the owned synthetic API with explicit model decisions for the profile suggestion RPC",
);

function profileEventCount(): number {
  const db = new Database(loadE2eDbPath(), { readonly: true });
  try {
    return (db.prepare(
      "SELECT COUNT(*) AS n FROM job_events WHERE event_type = 'ProfileUpdated'",
    ).get() as { n: number }).n;
  } finally { db.close(); }
}

test("Discovery Target search reviews persisted model decisions and saves only explicit preferences", async ({ page, baseURL }, testInfo) => {
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
  profile.resume.experience_entries[0].title = "Model proposal A";
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
    strategy: "model",
    status: "pending_confirmation",
    preferenceSuggestions: [],
  });
  expect(result.suggestions.slice(0, 2)).toMatchObject([
    { title: "Model proposal A", classification: "direct" },
    { title: "Model proposal B", classification: "adjacent" },
  ]);
  expect(result.determinationId).toMatch(/^[a-f0-9]{64}$/);
  const decisionDb = new Database(loadE2eDbPath(), {readonly:true});
  try {
    expect(decisionDb.prepare("SELECT status FROM candidate_interpretation_suggestions WHERE determination_id=?").get(result.determinationId)).toEqual({status:"pending_confirmation"});
    expect(decisionDb.prepare("SELECT kind FROM semantic_determinations WHERE determination_id=?").get(result.determinationId)).toEqual({kind:"candidate_interpretation"});
  } finally { decisionDb.close(); }
  expect(profileEventCount()).toBe(beforeEvents);
  expect((await (await page.request.get("/v1/profile")).json()).profileVersion).toBe(seedVersion);
  await expect(page.getByText(/Original suggestion: Model proposal A/)).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select Model proposal A" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Select Model proposal B" })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Add selected roles" })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Suggested role 1")).toBeVisible();
  await injectAxe(page);
  await checkA11y(page, ".target-search-settings", {
    axeOptions: { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } },
  });

  await page.getByLabel("Suggested role 1").fill("Platform Delivery Manager");
  await page.getByRole("checkbox", { name: "Select Platform Delivery Manager" }).check();
  await expect(page.getByText(/original evidence does not validate your edit/i).first()).toBeVisible();
  await page.getByRole("button", { name: "Reject Model proposal B" }).click();
  await page.getByRole("button", { name: "Reject Model proposal C" }).click();
  await page.getByRole("button", { name: "Add selected roles" }).click();
  await expect(page.getByRole("textbox", { name: "Target roles 1", exact: true })).toHaveValue("Director of Platform");
  await expect(page.getByRole("textbox", { name: "Target roles 2", exact: true })).toHaveValue("Platform Delivery Manager");
  await expect(page.getByRole("textbox", { name: "Target location 1", exact: true })).toHaveValue("Barcelona");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Discovery settings saved")).toBeVisible();
  const saved = await (await page.request.get("/v1/profile")).json();
  const confirmedDb = new Database(loadE2eDbPath(), {readonly:true});
  try {
    expect(confirmedDb.prepare("SELECT status FROM candidate_interpretation_suggestions WHERE determination_id=?").get(result.determinationId)).toEqual({status:"confirmed"});
  } finally { confirmedDb.close(); }
  await page.screenshot({path:testInfo.outputPath("semantic-profile-mobile.png"),fullPage:true});
  expect(saved.profile.experience).toMatchObject({
    target_role: "Director of Platform; Platform Delivery Manager",
    target_locations: "Barcelona",
    target_work_models: "Remote",
  });
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Target roles 2", exact: true })).toHaveValue("Platform Delivery Manager");

  await page.getByRole("button", { name: "Suggest roles" }).click();
  await expect(page.getByRole("button", { name: "Add selected roles" })).toBeVisible();
  await page.getByRole("checkbox", { name: "Select Model proposal A" }).check();
  await page.getByRole("button", { name: "Reject Model proposal B" }).click();
  await page.getByRole("button", { name: "Reject Model proposal C" }).click();
  // Listen before editing can start an autosave: on slower runners the stale
  // response may arrive before the explicit Save click.
  const staleSavePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/v1/profile"
      && response.request().method() === "PATCH" && response.status() === 409,
  );
  await page.getByRole("button", { name: "Add selected roles" }).click();
  const externallyChanged = structuredClone(saved.profile);
  externallyChanged.personal.full_name = "External Synthetic Update";
  const external = await page.request.patch("/v1/profile", {
    headers,
    data: { profile: externallyChanged, expectedProfileVersion: saved.profileVersion },
  });
  expect(external.status(), await external.text()).toBe(200);
  await page.getByRole("button", { name: "Save changes" }).click();
  expect((await staleSavePromise).status()).toBe(409);
  await expect(page.getByText(/saved profile changed/i).first()).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Target roles 3", exact: true })).toHaveValue("Model proposal A");
  await page.getByRole("button", { name: "Rebase edits onto saved profile" }).click();
  await expect(page.getByText(/Draft rebased and stale suggestions removed/)).toBeVisible();
  await page.getByRole("button", { name: "Suggest roles" }).click();
  await page.getByRole("button", { name: "Reject Model proposal A" }).click();
  await page.getByRole("button", { name: "Reject Model proposal C" }).click();
  await page.getByRole("checkbox", { name: "Select Model proposal B" }).check();
  await page.getByRole("button", { name: "Add selected roles" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Discovery settings saved")).toBeVisible();
  await page.reload();
  const final = await (await page.request.get("/v1/profile")).json();
  expect(final.profile.personal.full_name).toBe("External Synthetic Update");
  expect(final.profile.experience.target_role).toContain("Model proposal B");
  expect(final.profile.experience.target_locations).toBe("Barcelona");
  await page.getByRole("button", { name: "Add role", exact: true }).click();
  await page.getByRole("textbox", { name: "Target roles 4", exact: true }).fill("Synthetic Manual Architect");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Discovery settings saved")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Target roles 4", exact: true }))
    .toHaveValue("Synthetic Manual Architect");
  expect(errors.filter((message) => !message.includes("status of 409 (Conflict)"))).toEqual([]);
});
