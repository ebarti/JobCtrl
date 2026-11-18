import { test, expect, json } from "../harness/fixtures.js";
import { browserStorage } from "../harness/browser-storage.js";
import {
  baseline,
  createBaseline,
  type Library,
  type Profile,
} from "./core-data.js";

test("conflicting Profile saves and stale exact-wording approval retain the newer accepted source", async ({
  api,
  page,
  app,
}) => {
  const secondaryErrors: string[] = [];
  page.context().on("page", (other) => {
    if (other === page) return;
    other.on("pageerror", (error) => secondaryErrors.push(error.message));
    other.on("console", (message) => {
      if (message.type() === "error") secondaryErrors.push(message.text());
    });
  });
  const authored = {
    ...baseline,
    personal: {
      ...baseline.personal,
      password: "owned-canonical-password-sentinel",
      authored_extra: { retained: ["personal"] },
    },
    resume: {
      ...baseline.resume,
      experience_entries: baseline.resume.experience_entries.map(
        (role, index) => ({
          ...role,
          achievement_ids: role.bullets.map(
            (_, bullet) => `authored-achievement-${index}-${bullet}`,
          ),
          authored_extra: { retained: ["role", index] },
          achievement_evidence:
            index === 0
              ? [
                  {
                    id: "authored-evidence",
                    source_text: role.bullets[0]!,
                    claim_confidence: 1,
                    evidence_strength: "verified",
                    user_confirmed: true,
                    authored_extra: { retained: ["evidence"] },
                  },
                ]
              : [],
        }),
      ),
      education_entries: baseline.resume.education_entries.map((entry) => ({
        ...entry,
        authored_extra: { retained: ["education"] },
      })),
      skill_categories: baseline.resume.skill_categories.map((entry) => ({
        ...entry,
        authored_extra: { retained: ["skill"] },
      })),
      tailoring_rules: {
        tailoring_policy: {
          allow_title_reframing: true,
          allow_achievement_rewriting: false,
          allow_minor_inference: false,
          claim_mode: "verified_only",
          auto_approvable_claim_modes: ["verified_only"],
          authored_extra: { retained: ["policy"] },
        },
      },
    },
  };
  const { profile: initial, library } = await createBaseline(api, authored);
  const achievement = library.roles[0]!.achievements[0]!;
  const proposedText =
    "Built durable workflow recovery with documented operational ownership.";
  const pending = await json<Library>(api, "post", "/v1/profile/wording", {
    expectedProfileVersion: library.profileVersion,
    achievementId: achievement.achievement_id,
    text: proposedText,
    sourceRefs: achievement.source_refs,
  });
  const variant = pending.variants.find((row) => row.text === proposedText)!;
  expect(variant.status).toBe("pending");
  expect(variant.approval_id).toBeNull();
  const originalVersion = pending.profileVersion;
  const proposals = ["Synthetic Writer A", "Synthetic Writer B"].map(
    (name) => ({
      expectedProfileVersion: originalVersion,
      profile: {
        ...initial.profile,
        personal: { ...initial.profile.personal, full_name: name },
      },
    }),
  );
  const results = await Promise.all(
    proposals.map((data) => api.patch("/v1/profile", { data })),
  );
  expect(results.map((result) => result.status()).sort()).toEqual([200, 409]);
  const winningIndex = results.findIndex((result) => result.status() === 200);
  const winner = await json<Profile>(api, "get", "/v1/profile");
  expect(winner.profile.personal.full_name).toBe(
    proposals[winningIndex]!.profile.personal.full_name,
  );
  expect(winner.profileVersion).toBe(originalVersion + 1);

  const staleApproval = await api.post(
    `/v1/profile/wording/${encodeURIComponent(variant.variant_id)}/decision`,
    {
      data: {
        expectedProfileVersion: originalVersion,
        expectedVariantRevision: variant.revision,
        exactText: variant.text,
        decision: "approve",
      },
    },
  );
  expect(staleApproval.status()).toBe(409);
  const retained = await json<Library>(api, "get", "/v1/profile/wording");
  expect(
    retained.variants.find((row) => row.variant_id === variant.variant_id)!
      .status,
  ).toBe("pending");
  expect(
    retained.variants.filter((row) => row.status === "approved"),
  ).toHaveLength(3);
  expect((await json<Profile>(api, "get", "/v1/profile")).profile).toEqual(
    winner.profile,
  );

  await page.goto("/profile");
  await expect(page.getByText(proposedText, { exact: true })).toBeVisible();
  // The actual Profile form must preserve stable identities, nested authored
  // fields and literal policy values while editing an unrelated known field.
  const editedName = "Synthetic Browser Writer";
  const sections = page.getByRole("navigation", {
    name: "My profile sections",
    exact: true,
  });
  await sections
    .getByRole("link", { name: "Personal details", exact: true })
    .click();
  await page.getByLabel("Full name", { exact: true }).fill(editedName);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  let edited: Profile | undefined;
  await expect
    .poll(async () => {
      edited = await json<Profile>(api, "get", "/v1/profile");
      return edited.profileVersion;
    })
    .toBe(winner.profileVersion + 1);
  expect(edited!.profile).toEqual({
    ...winner.profile,
    personal: { ...winner.profile.personal, full_name: editedName },
  });
  await page.reload();
  await expect(page.getByLabel("Full name", { exact: true })).toHaveValue(
    editedName,
  );
  await sections.getByRole("link", { name: "Experience", exact: true }).click();
  await expect(page.getByText(proposedText, { exact: true })).toBeVisible();

  const modelCount = app.external.calls.filter(
    (call) => call.path === "/model",
  ).length;
  const main = page.getByRole("navigation", {
    name: "Main navigation",
    exact: true,
  });
  const name = page.getByRole("textbox", { name: "Full name", exact: true });
  const openPersonal = async () => {
    await main.getByRole("link", { name: "My profile", exact: true }).click();
    await sections
      .getByRole("link", { name: "Personal details", exact: true })
      .click();
  };
  await sections
    .getByRole("link", { name: "Personal details", exact: true })
    .click();
  await name.fill("Synthetic unfinished Profile one");
  await main.getByRole("link", { name: "Jobs", exact: true }).click();
  await openPersonal();
  await expect(name).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: "Restore unfinished Profile changes",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    (await json<Profile>(api, "get", "/v1/profile")).profile.personal.full_name,
  ).toBe(editedName);
  await main.getByRole("link", { name: "Jobs", exact: true }).click();
  await openPersonal();
  await page.reload();
  await expect(name).toBeDisabled();
  await page
    .getByRole("button", {
      name: "Restore unfinished Profile changes",
      exact: true,
    })
    .click();
  await expect(name).toHaveValue("Synthetic unfinished Profile one");
  await expect(name).toBeVisible();
  await name.fill("Synthetic unfinished Profile two");
  await main.getByRole("link", { name: "Jobs", exact: true }).click();
  await openPersonal();
  await page.reload();
  await expect(name).toBeDisabled();
  await page
    .getByRole("button", {
      name: "Restore unfinished Profile changes",
      exact: true,
    })
    .click();
  await expect(name).toHaveValue("Synthetic unfinished Profile two");
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(name).toHaveValue(editedName);
  await name.fill("Synthetic explicitly discarded recovery");
  await main.getByRole("link", { name: "Jobs", exact: true }).click();
  await openPersonal();
  await page
    .getByRole("button", { name: "Discard saved recovery copy", exact: true })
    .click();
  await expect(name).toBeEnabled();
  await expect(name).toHaveValue(editedName);
  await name.fill("Synthetic newest retained Profile");
  await main.getByRole("link", { name: "Jobs", exact: true }).click();
  await openPersonal();
  await page.reload();
  await page
    .getByRole("button", {
      name: "Restore unfinished Profile changes",
      exact: true,
    })
    .click();
  await expect(name).toHaveValue("Synthetic newest retained Profile");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await json<Profile>(api, "get", "/v1/profile")).profile.personal
          .full_name,
    )
    .toBe("Synthetic newest retained Profile");
  expect(
    app.external.calls.filter((call) => call.path === "/model"),
  ).toHaveLength(modelCount);

  await test.step("independent browser tabs retain the losing draft when the owning tab saves", async () => {
    const other = await page.context().newPage();
    await openPersonal();
    await other.goto("/profile?section=personal");
    const otherName = other.getByRole("textbox", {
      name: "Full name",
      exact: true,
    });
    const otherCity = other.getByRole("textbox", { name: "City", exact: true });
    await expect(otherName).toBeEnabled();
    await name.fill("Synthetic concurrent owner");
    // The two real pages share browser storage, while their live drafts and
    // ownership tokens remain independent.
    await expect
      .poll(async () =>
        (await browserStorage(page)).includes("Synthetic concurrent owner"),
      )
      .toBe(true);
    await otherCity.fill("Synthetic losing-tab city");
    await expect(
      other.getByRole("button", {
        name: "Retry recovery ownership",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await json<Profile>(api, "get", "/v1/profile")).profile.personal
            .full_name,
      )
      .toBe("Synthetic concurrent owner");
    await other
      .getByRole("navigation", { name: "Main navigation", exact: true })
      .getByRole("link", { name: "Jobs", exact: true })
      .click();
    await other
      .getByRole("navigation", { name: "Main navigation", exact: true })
      .getByRole("link", { name: "My profile", exact: true })
      .click();
    await other
      .getByRole("navigation", { name: "My profile sections", exact: true })
      .getByRole("link", { name: "Personal details", exact: true })
      .click();
    await other
      .getByRole("button", {
        name: "Restore unfinished Profile changes",
        exact: true,
      })
      .click();
    await expect(otherCity).toHaveValue("Synthetic losing-tab city");
    await expect(otherName).toHaveValue("Synthetic concurrent owner");
    await other
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await json<Profile>(api, "get", "/v1/profile")).profile.personal
            .city,
      )
      .toBe("Synthetic losing-tab city");
    await other.close();
  });

  await test.step("a second tab cannot silently replace a newer pending wording and preserves the first edit's recovery", async () => {
    await page.goto("/profile");
    const card = page.getByRole("article", {
      name: "Proposed revision 1",
      exact: true,
    });
    await card.getByRole("button", { name: "Edit draft", exact: true }).click();
    const firstEdit =
      "Synthetic first-tab pending wording retained for explicit review.";
    const secondEdit =
      "Synthetic second-tab saved pending wording with its exact source.";
    await card
      .getByRole("textbox", { name: "Wording text", exact: true })
      .fill(firstEdit);
    await expect
      .poll(async () => (await browserStorage(page)).includes(firstEdit))
      .toBe(true);
    const other = await page.context().newPage();
    await other.goto("/profile");
    const otherCard = other.getByRole("article", {
      name: "Proposed revision 1",
      exact: true,
    });
    await otherCard
      .getByRole("button", { name: "Restore unfinished edit", exact: true })
      .click();
    await otherCard
      .getByRole("textbox", { name: "Wording text", exact: true })
      .fill(secondEdit);
    await otherCard
      .getByRole("button", { name: "Save wording draft", exact: true })
      .click();
    await expect(otherCard.locator(".profile-wording-text")).toHaveText(
      secondEdit,
    );
    await expect(
      card.getByRole("button", { name: "Save wording draft", exact: true }),
    ).toBeDisabled();
    await expect(card).toContainText(
      "saving is paused until you review the current version",
    );
    await expect(
      card.getByRole("textbox", { name: "Wording text", exact: true }),
    ).toHaveValue(firstEdit);
    await page.reload();
    await card
      .getByRole("button", { name: "Restore unfinished edit", exact: true })
      .click();
    await expect(
      card.getByRole("textbox", { name: "Wording text", exact: true }),
    ).toHaveValue(firstEdit);
    await expect(
      card.getByRole("button", { name: "Save wording draft", exact: true }),
    ).toBeDisabled();
    expect(
      (await json<Library>(api, "get", "/v1/profile/wording")).variants.find(
        (row) => row.variant_id === variant.variant_id,
      )!.text,
    ).toBe(secondEdit);
    await card
      .getByRole("button", { name: "Discard edit", exact: true })
      .click();
    await other.close();
  });

  await test.step("safe recovery stores changed fields while private edits stay in the active app session", async () => {
    await page.goto("/profile?section=personal");
    await name.fill("Synthetic safe recovery without password");
    await expect
      .poll(async () =>
        (await browserStorage(page)).includes(
          "Synthetic safe recovery without password",
        ),
      )
      .toBe(true);
    expect(await browserStorage(page)).not.toContain(
      "owned-canonical-password-sentinel",
    );
    await page.reload();
    await page
      .getByRole("button", {
        name: "Restore unfinished Profile changes",
        exact: true,
      })
      .click();
    await expect(name).toHaveValue("Synthetic safe recovery without password");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await json<Profile>(api, "get", "/v1/profile")).profile.personal
            .full_name,
      )
      .toBe("Synthetic safe recovery without password");
    const saved = await json<{ profile: { personal: { password: string } } }>(
      api,
      "get",
      "/v1/profile",
    );
    expect(saved.profile.personal.password).toBe(
      "owned-canonical-password-sentinel",
    );
    await page.goto("/preferences#preferences-application");
    const password = page.getByLabel("Job-site login password", {
      exact: true,
    });
    await expect(password).toHaveValue("owned-canonical-password-sentinel");
    await password.fill("owned-unsaved-password-sentinel");
    await expect(
      page.getByText(
        "Password and credential edits stay only in this app session. Save them before reloading or closing the app.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(await browserStorage(page)).not.toContain(
      "owned-unsaved-password-sentinel",
    );
    expect(await browserStorage(page)).not.toContain(
      "owned-canonical-password-sentinel",
    );
    await main.getByRole("link", { name: "Jobs", exact: true }).click();
    await main.getByRole("link", { name: "My profile", exact: true }).click();
    await sections
      .getByRole("link", { name: "Search preferences", exact: true })
      .click();
    await page
      .locator("summary")
      .filter({ hasText: /^Application and resume defaults$/ })
      .click();
    await page
      .getByRole("button", {
        name: "Restore unfinished Profile changes",
        exact: true,
      })
      .click();
    await expect(password).toHaveValue("owned-unsaved-password-sentinel");
    const blockedReload = page.waitForEvent("dialog").then(async (dialog) => {
      expect(dialog.type()).toBe("beforeunload");
      await dialog.dismiss();
    });
    await Promise.all([
      blockedReload,
      page.evaluate(() => window.location.reload()),
    ]);
    await expect(password).toHaveValue("owned-unsaved-password-sentinel");
    await page
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    await expect(password).toHaveValue("owned-canonical-password-sentinel");
  });
  expect(
    secondaryErrors,
    "Browser errors in the independent Profile tabs",
  ).toEqual([]);
});
