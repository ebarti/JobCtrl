import type { APIResponse } from "@playwright/test";
import { test, expect, json } from "../harness/fixtures.js";
import { baseline, createBaseline, type Profile } from "./core-data.js";

test("Skills Enter saves authored edits, focuses one new field and preserves newer typing across acknowledgements", async ({ api, app, page }, testInfo) => {
  const authored = structuredClone(baseline);
  authored.resume.skill_categories.push({ id: "skills-operations", label: "Operations", items: ["Release governance"] });
  authored.resume.education_entries.push({ id: "education-second", degree: "Synthetic Systems Diploma", institution: "Synthetic Systems College", date: "2021" });
  const { profile: original } = await createBaseline(api, authored);
  const canonical = () => json<Profile>(api, "get", "/v1/profile");
  const patches: { expectedProfileVersion: number; profile: Profile["profile"] }[] = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH" && new URL(request.url()).pathname === "/v1/profile") patches.push(request.postDataJSON());
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/profile?section=skills");
  const section = page.locator("#profile-skills");
  const category = section.getByRole("group", { name: "Engineering", exact: true });
  const skill = (index: number) => category.getByRole("textbox", { name: `Skill ${index}`, exact: true });
  await expect(skill(1)).toHaveValue("Python");
  await expect(section.getByText("Skills are included in every resume.", { exact: false })).toHaveCount(1);
  await expect(section.getByText("Included in every resume", { exact: true })).toHaveCount(0);
  for (const group of ["Engineering", "Operations"]) {
    const visibleLabels = await section.getByRole("group", { name: group, exact: true }).locator("label").evaluateAll((labels) =>
      labels.filter((label) => { const box = label.getBoundingClientRect(); return box.width > 1 && box.height > 1; }).map((label) => label.textContent?.trim()));
    expect(visibleLabels.some((label) => /^Skill \d+$/.test(label ?? ""))).toBe(false);
  }
  await page.evaluate(() => {
    const observed = { submits: 0, repeatedEnters: 0, compositionStarts: 0, compositionEnds: 0 };
    (globalThis as unknown as { profileSkillKeyboard: typeof observed }).profileSkillKeyboard = observed;
    document.addEventListener("submit", () => { observed.submits += 1; }, true);
    document.addEventListener("keydown", (event) => { if (event.key === "Enter" && event.repeat) observed.repeatedEnters += 1; }, true);
    document.addEventListener("compositionstart", () => { observed.compositionStarts += 1; }, true);
    document.addEventListener("compositionend", () => { observed.compositionEnds += 1; }, true);
  });

  let releaseAcknowledgement: () => void = () => undefined;
  let heldFirstPatch = false;
  const acknowledgement = new Promise<void>((resolve) => { releaseAcknowledgement = resolve; });
  await page.route("**/v1/profile", async (route) => {
    if (route.request().method() !== "PATCH" || heldFirstPatch) { await route.continue(); return; }
    heldFirstPatch = true;
    const response = await route.fetch();
    await acknowledgement;
    await route.fulfill({ response });
  });
  try {
    await skill(1).fill("Python service recovery");
    const admitted = page.waitForRequest((request) => request.method() === "PATCH" && new URL(request.url()).pathname === "/v1/profile", { timeout: 4_000 });
    await skill(1).press("Enter");
    const first = await admitted;
    expect(first.postDataJSON()).toMatchObject({ expectedProfileVersion: original.profileVersion });
    await expect(skill(4)).toBeFocused();
    await expect(skill(4)).toHaveValue("");
    await expect(category.getByRole("textbox", { name: /^Skill \d+$/ })).toHaveCount(4);
    await expect.poll(async () => (await canonical()).profile.resume.skill_categories[0]!.items)
      .toEqual(["Python service recovery", "SQLite", "Temporal"]);
    await skill(4).press("Enter");
    await expect(skill(4)).toBeFocused();
    await expect(category.getByRole("textbox", { name: /^Skill \d+$/ })).toHaveCount(4);
    expect(patches).toHaveLength(1);

    await skill(4).fill("Recovery rehearsal");
    await page.keyboard.down("Enter");
    await expect(skill(5)).toBeFocused();
    await skill(5).fill("Release sequence ownership");
    await page.keyboard.down("Enter");
    await page.keyboard.up("Enter");
    await expect(skill(5)).toBeFocused();
    await expect(category.getByRole("textbox", { name: /^Skill \d+$/ })).toHaveCount(5);
    // The second explicit Enter waits for the first real server acknowledgement.
    expect(patches).toHaveLength(1);
    const latestSaved = page.waitForResponse(async (response) => response.request().method() === "PATCH"
      && new URL(response.url()).pathname === "/v1/profile" && response.status() === 200
      && (await response.json()).profile?.resume?.skill_categories[0]?.items[4] === "Release sequence ownership");
    releaseAcknowledgement();
    expect((await latestSaved).status()).toBe(200);
    const saved = await canonical();
    expect(patches).toHaveLength(2);
    expect(patches.map((patch) => patch.expectedProfileVersion)).toEqual([original.profileVersion, original.profileVersion + 1]);
    expect(saved.profile.resume.skill_categories[0]).toEqual({ ...original.profile.resume.skill_categories[0], items: ["Python service recovery", "SQLite", "Temporal", "Recovery rehearsal", "Release sequence ownership"] });
    expect(saved.profile.resume.skill_categories.slice(1)).toEqual(original.profile.resume.skill_categories.slice(1));
    expect(saved.profile.resume.education_entries).toEqual(original.profile.resume.education_entries);
    expect(saved.profile.resume.experience_entries).toEqual(original.profile.resume.experience_entries);
    expect(saved.profile.personal).toEqual(original.profile.personal);
    await expect(skill(5)).toHaveValue("Release sequence ownership");
    await expect(skill(5)).toBeFocused();
  } finally { releaseAcknowledgement(); }

  // Compose and commit text through Chromium's actual input-method boundary.
  const cdp = await page.context().newCDPSession(page);
  try {
    await skill(5).focus();
    await skill(5).press("ControlOrMeta+A");
    const text = "Synthetic multilingual review";
    await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
    const composition = await page.evaluate(() => (globalThis as unknown as { profileSkillKeyboard: { compositionStarts: number; compositionEnds: number } }).profileSkillKeyboard);
    expect(composition.compositionStarts).toBeGreaterThan(composition.compositionEnds);
    const beforeImeEnter = patches.length;
    // VK_PROCESSKEY is the native Enter processing path while an IME owns input.
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
    await expect(category.getByRole("textbox", { name: /^Skill \d+$/ })).toHaveCount(5);
    expect(patches).toHaveLength(beforeImeEnter);
    const afterImeEnter = await page.evaluate(() => (globalThis as unknown as { profileSkillKeyboard: { compositionStarts: number; compositionEnds: number } }).profileSkillKeyboard);
    if (afterImeEnter.compositionStarts > afterImeEnter.compositionEnds) await cdp.send("Input.insertText", { text });
    await expect(skill(5)).toHaveValue(text);
    const composedSaved = page.waitForResponse(async (response) => response.request().method() === "PATCH"
      && new URL(response.url()).pathname === "/v1/profile" && response.status() === 200
      && (await response.json()).profile?.resume?.skill_categories[0]?.items[4] === text);
    await skill(5).press("Enter");
    await expect(skill(6)).toBeFocused();
    expect((await composedSaved).status()).toBe(200);
    expect((await canonical()).profile.resume.skill_categories[0]!.items).toEqual(["Python service recovery", "SQLite", "Temporal", "Recovery rehearsal", text]);
    const observed = await page.evaluate(() => (globalThis as unknown as { profileSkillKeyboard: { submits: number; repeatedEnters: number; compositionStarts: number; compositionEnds: number } }).profileSkillKeyboard);
    expect(observed.submits).toBe(0);
    expect(observed.repeatedEnters).toBeGreaterThan(0);
    expect(observed.compositionStarts).toBeGreaterThan(0);
    expect(observed.compositionEnds).toBeGreaterThan(0);
  } finally { await cdp.detach(); }
  await testInfo.attach("profile-skills-enter", { contentType: "image/png", body: await section.screenshot({ animations: "disabled" }) });
  await page.reload();
  await expect(category.getByRole("textbox", { name: /^Skill \d+$/ })).toHaveCount(5);
  await expect(skill(5)).toHaveValue("Synthetic multilingual review");
  await page.getByRole("navigation", { name: "My profile sections", exact: true }).getByRole("link", { name: "Education", exact: true }).click();
  const education = page.locator("#profile-education");
  await expect(education.getByText("Education is included in every resume.", { exact: false })).toHaveCount(1);
  await expect(education.getByText("Included in every resume", { exact: true })).toHaveCount(0);
  expect((await canonical()).profile.resume.education_entries).toEqual(original.profile.resume.education_entries);
  expect(app.external.calls).toHaveLength(0);
});

test("Skills new fields stay local until their exact row is accepted across structural edits", async ({ api, app, page }, testInfo) => {
  const authored = structuredClone(baseline);
  authored.resume.skill_categories[0]!.items = ["Python", "SQL"];
  authored.resume.skill_categories.push({ id: "retained-blank", label: "Retained authored group", items: [""] });
  const { profile: original } = await createBaseline(api, authored);
  const canonical = () => json<Profile>(api, "get", "/v1/profile");
  const patches: unknown[] = [];
  page.on("request", (request) => { if (request.method() === "PATCH" && new URL(request.url()).pathname === "/v1/profile") patches.push(request.postDataJSON()); });
  await page.goto("/profile?section=skills");
  const category = page.locator("#profile-skills").getByRole("group", { name: "Engineering", exact: true });
  const skill = (index: number) => category.getByRole("textbox", { name: `Skill ${index}`, exact: true });
  await expect(skill(2)).toHaveValue("SQL");
  await category.getByRole("button", { name: "Add skill", exact: true }).click();
  await expect(skill(3)).toBeFocused();
  await skill(3).fill("Transient draft skill");
  await skill(3).fill("");
  await expect(skill(3)).toBeFocused();
  await skill(3).press("Enter");
  await expect(category.getByRole("textbox", { name: /^Skill \d+$/ })).toHaveCount(3);
  // Observe beyond the real five-second autosave deadline, on the same browser clock.
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 6_000)));
  expect(patches).toHaveLength(0);
  expect(await canonical()).toEqual(original);

  await category.getByRole("button", { name: "Remove skill 2", exact: true }).click();
  await testInfo.attach("skills-after-row-removal-geometry", {
    contentType: "application/json",
    body: JSON.stringify(await page.locator("#profile-skills").evaluate((section) => {
      const elements = [section, ...section.querySelectorAll("fieldset, [data-slot='field-group'], input, button")];
      return {
        activeElement: document.activeElement ? {
          tag: document.activeElement.tagName, id: document.activeElement.id, className: document.activeElement.className,
        } : null,
        elements: elements.map((element) => {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            tag: element.tagName, id: element.id, className: element.className,
            label: element.getAttribute("aria-label"), text: element instanceof HTMLInputElement ? element.value : element.textContent?.trim().slice(0, 80),
            box: { x: box.x, y: box.y, width: box.width, height: box.height }, clientRects: element.getClientRects().length,
            display: style.display, visibility: style.visibility, opacity: style.opacity,
            overflow: style.overflow, contain: style.contain, containerType: style.containerType, contentVisibility: style.contentVisibility,
          };
        }),
      };
    }), null, 2),
  });
  await category.getByRole("button", { name: "Add skill", exact: true }).click();
  await expect(skill(2)).toBeFocused();
  // The SQL prefix matches the removed saved value but is not an acknowledgement.
  await skill(2).pressSequentially("SQLite");
  await skill(2).fill("");
  await expect(skill(2)).toBeFocused();
  const removal = page.waitForResponse(async (response) => response.request().method() === "PATCH"
    && new URL(response.url()).pathname === "/v1/profile" && response.status() === 200);
  expect((await removal).status()).toBe(200);
  const saved = await canonical();
  expect(patches).toHaveLength(1);
  expect(saved.profileVersion).toBe(original.profileVersion + 1);
  expect(saved.profile.resume.skill_categories[0]!.items).toEqual(["Python"]);
  expect(saved.profile.resume.skill_categories[1]).toEqual(original.profile.resume.skill_categories[1]);
  await expect(category.getByRole("textbox", { name: /^Skill \d+$/ })).toHaveCount(2);
  await expect(skill(2)).toHaveValue("");
  let releaseStructuralAcknowledgement: () => void = () => undefined;
  const structuralGate = new Promise<void>((resolve) => { releaseStructuralAcknowledgement = resolve; });
  let heldStructuralSave = false;
  await page.route("**/v1/profile", async (route) => {
    if (route.request().method() !== "PATCH" || heldStructuralSave) { await route.continue(); return; }
    heldStructuralSave = true;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await structuralGate;
    await route.fulfill({ response });
  });
  try {
    await skill(2).fill("Python");
    await skill(2).fill("SQL");
    const requested = page.waitForRequest((request) => request.method() === "PATCH" && new URL(request.url()).pathname === "/v1/profile");
    await skill(2).press("Enter");
    await requested;
    await expect.poll(async () => (await canonical()).profile.resume.skill_categories[0]!.items).toEqual(["Python", "SQL"]);
    // The new Go row is not in the submitted payload. SQL is, even after it moves.
    await skill(3).fill("Go");
    await category.getByRole("button", { name: "Remove skill 1", exact: true }).click();
    await expect(skill(1)).toHaveValue("SQL");
    await expect(skill(2)).toHaveValue("Go");
    const acknowledged = page.waitForResponse((response) => response.request().method() === "PATCH"
      && new URL(response.url()).pathname === "/v1/profile" && response.status() === 200);
    releaseStructuralAcknowledgement();
    await acknowledged;
    await expect(page.locator(".profile-save-status")).toHaveText("Saved; newer changes pending");
    const cleared = page.waitForResponse(async (response) => response.request().method() === "PATCH"
      && new URL(response.url()).pathname === "/v1/profile" && response.status() === 200
      && JSON.stringify((await response.json()).profile?.resume?.skill_categories[0]?.items) === JSON.stringify([""]));
    // Erasing accepted SQL keeps its authored row; newer Go must not move into it.
    await skill(1).fill("");
    await expect(skill(1)).toBeFocused();
    await expect(skill(1)).toHaveValue("");
    await expect(skill(2)).toHaveValue("Go");
    await expect(category.getByRole("textbox", { name: /^Skill \d+$/ })).toHaveCount(2);
    // This row was absent from the acknowledged submission and still demotes locally.
    await skill(2).fill("");
    await expect(skill(2)).toBeFocused();
    await expect(skill(2)).toHaveValue("");
    await cleared;
    const afterStructuralEdit = await canonical();
    expect(afterStructuralEdit.profile.resume.skill_categories[0]!.items).toEqual([""]);
    expect(afterStructuralEdit.profile.resume.skill_categories[1]).toEqual(original.profile.resume.skill_categories[1]);
    expect(afterStructuralEdit.profileVersion).toBe(original.profileVersion + 3);
    expect(patches).toHaveLength(3);
    await expect(skill(1)).toHaveValue("");
    await expect(skill(2)).toHaveValue("");
    await expect(category.getByRole("textbox", { name: /^Skill \d+$/ })).toHaveCount(2);
  } finally { releaseStructuralAcknowledgement(); }
  expect(app.external.calls).toHaveLength(0);
});

test("Skills Enter preserves the latest draft after a rejected save without queued or automatic retry", async ({ api, app, page, allowResponseError }) => {
  const { profile: original } = await createBaseline(api);
  const patches: unknown[] = [];
  page.on("request", (request) => { if (request.method() === "PATCH" && new URL(request.url()).pathname === "/v1/profile") patches.push(request.postDataJSON()); });
  await page.goto("/profile?section=skills");
  const category = page.locator("#profile-skills").getByRole("group", { name: "Engineering", exact: true });
  const skill = (index: number) => category.getByRole("textbox", { name: `Skill ${index}`, exact: true });
  await expect(skill(1)).toHaveValue("Python");
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  await page.route("**/v1/profile", async (route) => {
    if (route.request().method() !== "PATCH" || held) { await route.continue(); return; }
    held = true;
    await gate;
    const response = await route.fetch();
    await route.fulfill({ response });
  });
  try {
    await skill(1).fill("Rejected initial edit");
    const requested = page.waitForRequest((request) => request.method() === "PATCH" && new URL(request.url()).pathname === "/v1/profile");
    await skill(1).press("Enter");
    await requested;
    await skill(4).fill("Retained newer skill");
    await skill(4).press("Enter");
    await expect(skill(5)).toBeFocused();
    const winner = await json<Profile>(api, "patch", "/v1/profile", {
      expectedProfileVersion: original.profileVersion,
      profile: { ...original.profile, personal: { ...original.profile.personal, full_name: "Synthetic independent saved writer" } },
    });
    const refused = page.waitForResponse((response) => response.request().method() === "PATCH"
      && new URL(response.url()).pathname === "/v1/profile" && response.status() === 409);
    release();
    await allowResponseError(await refused, { method: "PATCH", status: 409, code: "revision_conflict" });
    await expect(page.getByRole("alert").filter({ hasText: "The saved Profile has changed." }).first()).toBeVisible();
    await expect(skill(1)).toHaveValue("Rejected initial edit");
    await expect(skill(4)).toHaveValue("Retained newer skill");
    await expect(skill(5)).toBeFocused();
    // This observation includes the actual autosave deadline after the failed attempt.
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 6_000)));
    expect(patches).toHaveLength(1);
    expect(await json<Profile>(api, "get", "/v1/profile")).toEqual(winner);
    await expect(skill(4)).toHaveValue("Retained newer skill");
    expect(app.external.calls).toHaveLength(0);
  } finally { release(); }
});

test("Skills Enter preserves an uncertain committed write without admitting a follow-up save", async ({ api, app, page, allowRequestFailure }) => {
  const { profile: original } = await createBaseline(api);
  const patches: unknown[] = [];
  page.on("request", (request) => { if (request.method() === "PATCH" && new URL(request.url()).pathname === "/v1/profile") patches.push(request.postDataJSON()); });
  await page.goto("/profile?section=skills");
  const category = page.locator("#profile-skills").getByRole("group", { name: "Engineering", exact: true });
  const skill = (index: number) => category.getByRole("textbox", { name: `Skill ${index}`, exact: true });
  await expect(skill(1)).toHaveValue("Python");
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  let forwarded: APIResponse | undefined;
  let committed: Profile | undefined;
  await page.route("**/v1/profile", async (route) => {
    if (route.request().method() !== "PATCH" || held) { await route.continue(); return; }
    held = true;
    forwarded = await route.fetch();
    expect(forwarded.status()).toBe(200);
    committed = await forwarded.json() as Profile;
    await gate;
    await route.abort("failed");
  });
  try {
    await skill(1).fill("Committed uncertain edit");
    const requested = page.waitForRequest((request) => request.method() === "PATCH" && new URL(request.url()).pathname === "/v1/profile");
    await skill(1).press("Enter");
    const request = await requested;
    await expect.poll(async () => (await json<Profile>(api, "get", "/v1/profile")).profileVersion).toBe(original.profileVersion + 1);
    await skill(4).fill("Retained uncertain newer skill");
    await skill(4).press("Enter");
    await expect(skill(5)).toBeFocused();
    const failure = page.waitForEvent("requestfailed", { predicate: (candidate) => candidate === request });
    release();
    const failed = await failure;
    allowRequestFailure(failed, "net::ERR_FAILED", forwarded);
    await expect(page.getByRole("alert").filter({ hasText: "The change may have completed; check its current state before retrying." }).first()).toBeVisible();
    await expect(skill(1)).toHaveValue("Committed uncertain edit");
    await expect(skill(4)).toHaveValue("Retained uncertain newer skill");
    await expect(skill(5)).toBeFocused();
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 6_000)));
    expect(patches).toHaveLength(1);
    expect(committed).toBeDefined();
    expect(await json<Profile>(api, "get", "/v1/profile")).toEqual(committed);
    expect(committed!.profile.resume.skill_categories[0]!.items).toEqual(["Committed uncertain edit", "SQLite", "Temporal"]);
    await expect(skill(4)).toHaveValue("Retained uncertain newer skill");
    expect(app.external.calls).toHaveLength(0);
  } finally { release(); }
});
