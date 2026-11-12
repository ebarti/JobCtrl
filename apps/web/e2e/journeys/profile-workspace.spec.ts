import { errors, type Dialog } from "@playwright/test";
import { test, expect, json } from "../harness/fixtures.js";
import { browserStorage } from "../harness/browser-storage.js";
import { createBaseline, type Library, type Profile } from "./core-data.js";

type IdentityProfile = Omit<Profile, "profile"> & {
  profile: Omit<Profile["profile"], "resume"> & {
    resume: Omit<Profile["profile"]["resume"], "experience_entries"> & {
      experience_entries: (Profile["profile"]["resume"]["experience_entries"][number] & {
        achievement_ids: string[];
      })[];
    };
  };
};

test("Profile peer sections save complete role, summary, skills and education edits and restore removed experience with its original identities", async ({
  api,
  app,
  page,
}, testInfo) => {
  const { library: originalLibrary } = await createBaseline(api);
  const canonical = () => json<IdentityProfile>(api, "get", "/v1/profile");
  const callsBefore = app.external.calls.length;
  const save = async () => {
    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/v1/profile" &&
        response.request().method() === "PATCH",
    );
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    const response = await saved;
    expect(response.status(), await response.text()).toBe(200);
    return canonical();
  };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/profile");
  const sections = page.getByRole("navigation", {
    name: "My profile sections",
    exact: true,
  });
  const peer = (name: string) =>
    sections.getByRole("link", { name, exact: true });
  for (const name of [
    "Experience",
    "Skills",
    "Education",
    "Personal details",
    "Resume",
  ])
    await expect(peer(name)).toBeVisible();
  await expect(peer("Experience")).toHaveAttribute("aria-current", "page");
  for (const [hash, label] of [
    ["profile-personal", "Personal details"],
    ["profile-skills", "Skills"],
    ["profile-education", "Education"],
    ["profile-experience", "Experience"],
    ["profile-resume-editor", "Resume"],
  ]) {
    await page.goto(`/profile#${hash}`);
    await expect(peer(label!)).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("heading", { name: label!, level: 1, exact: true }),
    ).toBeVisible();
  }
  await page.goto("/profile?section=skills#profile-personal");
  await expect(peer("Skills")).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "Skills", level: 1, exact: true }),
  ).toBeVisible();
  await peer("Experience").click();
  await expect(
    page.getByRole("textbox", { name: "Full name", exact: true }),
  ).toHaveCount(0);
  const original = await canonical();
  const originalIds = original.profile.resume.experience_entries.map(
    (role) => ({ id: role.id, achievements: role.achievement_ids }),
  );
  await page
    .getByRole("textbox", { name: "Position summary (optional)", exact: true })
    .fill("Owned the service recovery roadmap and its review process.");
  let saved = await save();
  expect(saved.profile.resume.experience_entries[0]!.summary).toBe(
    "Owned the service recovery roadmap and its review process.",
  );
  expect(
    saved.profile.resume.experience_entries.map((role) => ({
      id: role.id,
      achievements: role.achievement_ids,
    })),
  ).toEqual(originalIds);

  for (const label of ["Start month", "End month"]) {
    await page.getByRole("combobox", { name: label, exact: true }).click();
    await page.getByRole("option", { name: "Sep", exact: true }).click();
  }
  saved = await save();
  expect(saved.profile.resume.experience_entries[0]!.date_range).toContain(
    "Sep",
  );
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    for (const label of ["Start month", "End month"]) {
      const value = page
        .getByRole("combobox", { name: label, exact: true })
        .locator('[data-slot="select-value"]');
      await expect(value).toHaveText("Sep");
      const geometry = await value.evaluate((element) => {
        const text = document.createRange();
        text.selectNodeContents(element);
        return {
          textWidth: text.getBoundingClientRect().width,
          width: element.clientWidth,
          scrollWidth: element.scrollWidth,
        };
      });
      expect(geometry.textWidth).toBeLessThanOrEqual(geometry.width + 1);
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
    }
    const datePath = testInfo.outputPath(
      `profile-date-range-selected-${viewport.width}.png`,
    );
    await page
      .locator(".date-range-field:visible")
      .screenshot({ path: datePath });
    await testInfo.attach(`profile-date-range-selected-${viewport.width}`, {
      contentType: "image/png",
      path: datePath,
    });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.getByRole("button", { name: "Add role", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Title", exact: true })
    .fill("Synthetic Recovery Lead");
  await page
    .getByRole("textbox", { name: "Company", exact: true })
    .fill("Synthetic New Company");
  await page
    .getByRole("textbox", { name: "Position summary (optional)", exact: true })
    .fill("Created an explicit recovery practice.");
  await page
    .getByRole("button", { name: "Add achievement", exact: true })
    .click();
  const achievementText =
    "Established a versioned recovery practice with an inspectable review record.";
  await page
    .getByRole("textbox", { name: "Achievement 1", exact: true })
    .fill(achievementText);
  saved = await save();
  const added = saved.profile.resume.experience_entries.find(
    (role) => role.title === "Synthetic Recovery Lead",
  )!;
  expect(added.id).toBeTruthy();
  expect(added.achievement_ids).toHaveLength(1);
  expect(added.achievement_ids[0]).toBeTruthy();
  const wording = await json<Library>(api, "get", "/v1/profile/wording");
  const addedLibraryRole = wording.roles.find(
    (role) => role.role_id === added.id,
  )!;
  expect(
    addedLibraryRole.achievements.map((row) => row.achievement_id),
  ).toEqual(added.achievement_ids);

  const achievementCard = page.getByRole("group", {
    name: "Achievement 1",
    exact: true,
  });
  const facts = achievementCard
    .locator("summary")
    .filter({ hasText: /^Edit facts$/ });
  // A newly added achievement starts with its facts editor open. Inspect the
  // collapsed reading state after saving, whether or not the editor remounted.
  if (
    (await achievementCard
      .locator(".profile-achievement-source")
      .getAttribute("open")) !== null
  )
    await facts.click();
  const authored = achievementCard.getByRole("article", {
    name: "Saved wording",
    exact: true,
  });
  await expect(authored.locator(".profile-wording-text")).toHaveText(
    achievementText,
  );
  await expect(achievementCard.locator(".profile-wording-text")).toHaveCount(1);
  await expect(
    achievementCard.getByRole("textbox", {
      name: "Achievement 1",
      exact: true,
    }),
  ).toBeHidden();
  await expect(
    achievementCard.getByRole("checkbox", {
      name: "Include in coaching",
      exact: true,
    }),
  ).toBeHidden();
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(
      authored.getByRole("button", { name: "Edit wording", exact: true }),
    ).toBeEnabled();
    const geometry = await achievementCard.evaluate((element) => ({
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
    await testInfo.attach(`achievement-saved-wording-${viewport.width}`, {
      contentType: "image/png",
      body: await achievementCard.screenshot(),
    });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await facts.click();
  await expect(
    achievementCard.getByRole("textbox", {
      name: "Achievement 1",
      exact: true,
    }),
  ).toHaveValue(achievementText);
  await expect(achievementCard).toContainText(
    "Saving facts updates this achievement’s source",
  );
  await testInfo.attach("achievement-edit-facts", {
    contentType: "image/png",
    body: await achievementCard.screenshot(),
  });
  await facts.click();
  const options = achievementCard
    .locator("summary")
    .filter({ hasText: /^Achievement options$/ });
  await options.click();
  await expect(
    achievementCard.getByRole("checkbox", {
      name: "Include in coaching",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    achievementCard.getByRole("button", {
      name: "Remove achievement 1",
      exact: true,
    }),
  ).toBeVisible();
  await options.click();
  await authored
    .getByRole("button", { name: "Edit wording", exact: true })
    .click();
  const firstDraft =
    "Established a versioned recovery practice and kept its reviewed operating record.";
  const finalDraft =
    "Established a versioned recovery practice with a reviewed operating record.";
  // Capture identity before typing so the immediate edit/reload race stays real.
  const guardedDocument = await page.evaluateHandle(() => document);
  try {
    const dismissals: Promise<
      | { type: string; acknowledged: true }
      | { type: string; acknowledged: false; error: unknown }
    >[] = [];
    const protectPendingCopy = (dialog: Dialog) => {
      const type = dialog.type();
      dismissals.push(dialog.dismiss().then(
        () => ({ type, acknowledged: true as const }),
        (error: unknown) => ({ type, acknowledged: false as const, error }),
      ));
    };
    await authored
      .getByRole("textbox", { name: "Wording text", exact: true })
      .fill(firstDraft);
    let reloadFailed = false;
    let reloadFailure: unknown;
    page.on("dialog", protectPendingCopy);
    try {
      await page.reload();
    } catch (error) {
      reloadFailed = true;
      reloadFailure = error;
    } finally {
      page.off("dialog", protectPendingCopy);
    }
    const dismissed = await Promise.all(dismissals);
    if (dismissed.length === 0 && reloadFailed) throw reloadFailure;
    const blockedReload = dismissed.length > 0;
    if (blockedReload) {
      expect(dismissed).toHaveLength(1);
      const dismissal = dismissed[0]!;
      if (!dismissal.acknowledged) throw dismissal.error;
      expect(dismissal.type).toBe("beforeunload");
      expect(
        await page.evaluate((original) => original === document, guardedDocument),
        "Acknowledged cancellation must preserve the original document",
      ).toBe(true);
      await expect(
        authored.getByRole("textbox", { name: "Wording text", exact: true }),
      ).toHaveValue(firstDraft);
      await expect(
        authored.getByText("Saving recovery copy…", { exact: true }),
      ).toHaveCount(0);
      expect(
        await browserStorage(page),
        "The real durable copy contains the latest text before a confirmed reload",
      ).toContain(firstDraft);
      if (reloadFailed) {
        expect(
          reloadFailure instanceof errors.TimeoutError ||
            /net::ERR_ABORTED|Navigation.*interrupted/.test(String(reloadFailure)),
          "Only the proven canceled reload may report an abort or navigation timeout",
        ).toBe(true);
      }
    }
    await testInfo.attach("wording-reload-protection", {
      contentType: "application/json",
      body: JSON.stringify({
        promptCount: dismissed.length,
        dismissalAcknowledged: blockedReload,
        originalDocumentPreserved: blockedReload ? true : null,
        reloadErrorName: reloadFailure instanceof Error ? reloadFailure.name : null,
      }),
    });
    if (blockedReload) await page.reload();
  } finally {
    await guardedDocument.dispose();
  }
  await expect(
    authored.getByRole("button", {
      name: "Restore unfinished edit",
      exact: true,
    }),
  ).toBeVisible();
  await testInfo.attach("achievement-wording-recovery", {
    contentType: "image/png",
    body: await achievementCard.screenshot(),
  });
  await authored
    .getByRole("button", { name: "Restore unfinished edit", exact: true })
    .click();
  await expect(
    authored.getByRole("textbox", { name: "Wording text", exact: true }),
  ).toHaveValue(firstDraft);
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const geometry = await authored
      .getByRole("textbox", { name: "Wording text", exact: true })
      .evaluate((element) => {
        const editor = element.getBoundingClientRect();
        const label = element.closest("label")!.getBoundingClientRect();
        return {
          editorWidth: editor.width,
          labelWidth: label.width,
          editorLeft: editor.left,
          labelLeft: label.left,
        };
      });
    expect(
      Math.abs(geometry.editorLeft - geometry.labelLeft),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(geometry.editorWidth - geometry.labelWidth),
    ).toBeLessThanOrEqual(1);
    await testInfo.attach(
      viewport.width === 1440
        ? "achievement-wording-edit"
        : `achievement-wording-edit-${viewport.width}`,
      {
        contentType: "image/png",
        body: await achievementCard.screenshot({ animations: "disabled" }),
      },
    );
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await authored
    .getByRole("button", { name: "Discard edit", exact: true })
    .click();
  await expect(
    authored.getByText(achievementText, { exact: true }),
  ).toBeVisible();
  await authored
    .getByRole("button", { name: "Undo discarded edit", exact: true })
    .click();
  await expect(
    authored.getByRole("textbox", { name: "Wording text", exact: true }),
  ).toHaveValue(firstDraft);
  await authored
    .getByRole("button", { name: "Save wording draft", exact: true })
    .click();
  const proposal = page.getByRole("article", {
    name: "Proposed revision 1",
    exact: true,
  });
  await expect(proposal.locator(".profile-wording-text")).toHaveText(
    firstDraft,
  );
  await expect(authored.locator(".profile-wording-text")).toHaveText(
    achievementText,
  );
  await testInfo.attach("achievement-proposed-revision", {
    contentType: "image/png",
    body: await achievementCard.screenshot(),
  });
  let proposalLibrary = await json<Library>(api, "get", "/v1/profile/wording");
  const proposed = proposalLibrary.variants.find(
    (variant) => variant.text === firstDraft,
  )!;
  expect(proposed).toMatchObject({
    status: "pending",
    approval_id: null,
    achievement_id: added.achievement_ids[0],
  });
  expect(
    proposalLibrary.variants.find(
      (variant) =>
        variant.variant_id ===
        addedLibraryRole.achievements[0]!.baseline_variant_id,
    ),
  ).toMatchObject({ status: "approved", text: achievementText });
  expect(
    (await canonical()).profile.resume.experience_entries.find(
      (role) => role.id === added.id,
    )!.bullets,
  ).toEqual([achievementText]);
  await proposal
    .getByRole("button", { name: "Edit draft", exact: true })
    .click();
  await proposal
    .getByRole("textbox", { name: "Wording text", exact: true })
    .fill(finalDraft);
  await proposal
    .getByRole("button", { name: "Save wording draft", exact: true })
    .click();
  await expect(proposal.locator(".profile-wording-text")).toHaveText(
    finalDraft,
  );
  proposalLibrary = await json<Library>(api, "get", "/v1/profile/wording");
  expect(
    proposalLibrary.variants.find(
      (variant) => variant.variant_id === proposed.variant_id,
    ),
  ).toMatchObject({
    revision: proposed.revision + 1,
    status: "pending",
    text: finalDraft,
    approval_id: null,
  });
  await proposal
    .getByRole("button", { name: "Approve exact wording", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await json<Library>(api, "get", "/v1/profile/wording")).variants.find(
          (variant) => variant.variant_id === proposed.variant_id,
        )!.status,
    )
    .toBe("approved");
  const revisions = await json<{
    revisions: { revision: number; text: string }[];
  }>(api, "get", `/v1/profile/wording/${proposed.variant_id}/history`);
  expect(revisions.revisions.map((revision) => revision.text)).toEqual(
    expect.arrayContaining([firstDraft, finalDraft]),
  );
  const earlierWordings = achievementCard.locator(".profile-wording-history");
  await earlierWordings.locator("summary").first().click();
  const accepted = earlierWordings.getByRole("article", {
    name: "Earlier wording 1",
    exact: true,
  });
  await expect(accepted.locator(".profile-wording-text")).toHaveText(
    finalDraft,
  );
  await accepted
    .locator("summary")
    .filter({ hasText: /^Approval and history$/ })
    .click();
  await expect(accepted.getByText(firstDraft, { exact: true })).toBeVisible();
  await expect(
    accepted.getByRole("button", {
      name: "Restore text as draft",
      exact: true,
    }),
  ).toBeVisible();
  await testInfo.attach("achievement-approved-wording-history", {
    contentType: "image/png",
    body: await achievementCard.screenshot(),
  });
  await earlierWordings.locator("summary").first().click();
  expect(
    (await canonical()).profile.resume.experience_entries.find(
      (role) => role.id === added.id,
    )!.bullets,
  ).toEqual([achievementText]);

  await page
    .locator("summary:visible")
    .filter({ hasText: /^Achievement options$/ })
    .click();
  await page
    .getByRole("button", { name: "Remove achievement 1", exact: true })
    .click();
  await save();
  await page.reload();
  await page
    .locator("summary")
    .filter({ hasText: /^Restore removed experience$/ })
    .click();
  const removedAchievement = page
    .locator("li")
    .filter({ hasText: achievementText });
  await removedAchievement
    .getByRole("button", { name: "Restore achievement", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await canonical()).profile.resume.experience_entries.find(
          (role) => role.id === added.id,
        )!.achievement_ids,
    )
    .toEqual(added.achievement_ids);
  await page.reload();
  await page
    .getByRole("navigation", { name: "Career roles", exact: true })
    .getByRole("button")
    .filter({ hasText: "Synthetic Recovery Lead" })
    .click();
  await page
    .locator("summary:visible")
    .filter({ hasText: /^Edit facts$/ })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Achievement 1", exact: true }),
  ).toHaveValue(achievementText);
  await page
    .getByRole("button", { name: "Remove experience", exact: true })
    .click();
  await save();
  await page.reload();
  expect(
    (await canonical()).profile.resume.experience_entries.some(
      (role) => role.id === added.id,
    ),
  ).toBe(false);
  await page
    .locator("summary")
    .filter({ hasText: /^Restore removed experience$/ })
    .click();
  const removedRole = page
    .locator("li")
    .filter({ hasText: "Synthetic Recovery Lead · Synthetic New Company" });
  await removedRole
    .getByRole("button", { name: "Restore role", exact: true })
    .click();
  await expect
    .poll(async () =>
      (await canonical()).profile.resume.experience_entries.find(
        (role) => role.id === added.id,
      ),
    )
    .toEqual(added);
  const restoredLibrary = await json<Library>(
    api,
    "get",
    "/v1/profile/wording",
  );
  expect(
    restoredLibrary.roles.find((role) => role.role_id === added.id),
  ).toEqual(addedLibraryRole);
  expect(
    restoredLibrary.variants.find(
      (variant) =>
        variant.variant_id ===
        addedLibraryRole.achievements[0]!.baseline_variant_id,
    )?.text,
  ).toBe(achievementText);

  await peer("Skills").click();
  await expect(peer("Skills")).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("textbox", { name: "Title", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Label", exact: true }),
  ).toHaveCount(0);
  const originalCategory = original.profile.resume.skill_categories[0]!;
  const groupTitle = page
    .getByRole("group", { name: originalCategory.label, exact: true })
    .getByRole("textbox", { name: "Skill group title", exact: true });
  const renamedTitle = "Engineering & Recovery";
  const autosavedTitle = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/v1/profile" &&
      response.request().method() === "PATCH",
  );
  await groupTitle.focus();
  await groupTitle.press("ControlOrMeta+A");
  await groupTitle.pressSequentially(renamedTitle);
  const renamedCategory = page.getByRole("group", {
    name: renamedTitle,
    exact: true,
  });
  await expect(
    renamedCategory.getByRole("textbox", { name: "Skill group title", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    renamedCategory.getByRole("button", { name: "Remove skill category", exact: true }),
  ).toBeFocused();
  const titleResponse = await autosavedTitle;
  expect(titleResponse.status(), await titleResponse.text()).toBe(200);
  saved = await canonical();
  expect(
    saved.profile.resume.skill_categories.find((item) => item.id === originalCategory.id),
  ).toEqual({ ...originalCategory, label: renamedTitle });
  await page.reload();
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(
      renamedCategory.getByRole("textbox", { name: "Skill group title", exact: true }),
    ).toHaveValue(renamedTitle);
    const geometry = await renamedCategory.evaluate((element) => ({
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
    await testInfo.attach(`skill-group-title-${viewport.width}`, {
      contentType: "image/png",
      body: await page.locator("#profile-skills").screenshot({ animations: "disabled" }),
    });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("button", { name: "Add skill category", exact: true })
    .click();
  const category = page.getByRole("group", {
    name: "Skill category 2",
    exact: true,
  });
  await category
    .getByRole("textbox", { name: "Skill group title", exact: true })
    .fill("Synthetic Recovery Skills");
  const namedCategory = page.getByRole("group", {
    name: "Synthetic Recovery Skills",
    exact: true,
  });
  await namedCategory
    .getByRole("textbox", { name: "Skill 1", exact: true })
    .fill("Recovery review");
  saved = await save();
  const categoryId = saved.profile.resume.skill_categories.find(
    (item) => item.label === "Synthetic Recovery Skills",
  )!.id;
  await page.reload();
  await expect(
    namedCategory.getByRole("textbox", { name: "Skill 1", exact: true }),
  ).toHaveValue("Recovery review");
  await namedCategory
    .getByRole("textbox", { name: "Skill 1", exact: true })
    .fill("Recovery review and provenance");
  await namedCategory.getByRole("button", { name: "Add skill", exact: true }).click();
  await namedCategory
    .getByRole("textbox", { name: "Skill 2", exact: true })
    .fill("Synthetic incident protocols");
  saved = await save();
  expect(
    saved.profile.resume.skill_categories.find(
      (item) => item.id === categoryId,
    )!.items,
  ).toEqual(["Recovery review and provenance", "Synthetic incident protocols"]);
  await namedCategory
    .getByRole("button", { name: "Remove skill 2", exact: true })
    .click();
  saved = await save();
  expect(
    saved.profile.resume.skill_categories.find(
      (item) => item.id === categoryId,
    )!.items,
  ).toEqual(["Recovery review and provenance"]);
  await namedCategory
    .getByRole("button", { name: "Remove skill category", exact: true })
    .click();
  saved = await save();
  expect(
    saved.profile.resume.skill_categories.some(
      (item) => item.id === categoryId,
    ),
  ).toBe(false);

  await peer("Education").click();
  await page
    .getByRole("button", { name: "Add education", exact: true })
    .click();
  const education = page.getByRole("group", {
    name: "Education 2",
    exact: true,
  });
  await education
    .getByRole("textbox", { name: "Degree", exact: true })
    .fill("Synthetic Recovery Certificate");
  const namedEducation = page.getByRole("group", {
    name: "Synthetic Recovery Certificate",
    exact: true,
  });
  await namedEducation
    .getByRole("textbox", { name: "Institution", exact: true })
    .fill("Synthetic Recovery Institute");
  saved = await save();
  const educationId = saved.profile.resume.education_entries.find(
    (item) => item.degree === "Synthetic Recovery Certificate",
  )!.id;
  await page.reload();
  await expect(
    namedEducation.getByRole("textbox", { name: "Institution", exact: true }),
  ).toHaveValue("Synthetic Recovery Institute");
  await namedEducation
    .getByRole("textbox", { name: "Institution", exact: true })
    .fill("Synthetic Updated Institute");
  saved = await save();
  expect(
    saved.profile.resume.education_entries.find(
      (item) => item.id === educationId,
    )!.institution,
  ).toBe("Synthetic Updated Institute");
  await namedEducation
    .getByRole("button", { name: "Remove education", exact: true })
    .click();
  saved = await save();
  expect(
    saved.profile.resume.education_entries.some(
      (item) => item.id === educationId,
    ),
  ).toBe(false);
  await peer("Experience").click();
  await testInfo.attach("profile-peer-sections-and-restored-experience", {
    contentType: "image/png",
    body: await page.screenshot(),
  });
  expect(
    saved.profile.resume.experience_entries
      .filter((role) => originalIds.some((row) => row.id === role.id))
      .map((role) => ({ id: role.id, achievements: role.achievement_ids })),
  ).toEqual(originalIds);
  expect(
    originalLibrary.roles
      .flatMap((role) => role.achievements)
      .map((row) => row.achievement_id),
  ).toEqual(originalIds.flatMap((role) => role.achievements));
  expect(
    app.external.calls
      .slice(callsBefore)
      .filter((call) => call.path === "/model"),
  ).toEqual([]);
  expect(
    (
      await json<{ runs: unknown[] }>(
        api,
        "get",
        "/v1/action-runs?action=fit.refresh",
      )
    ).runs,
  ).toEqual([]);
});
