import { test, expect, json } from "../harness/fixtures.js";
import {
  baseline,
  createBaseline,
  type Library,
  type Profile,
} from "./core-data.js";

test("conflicting Profile saves and stale exact-wording approval retain the newer accepted source", async ({
  api,
  page,
}) => {
  const authored = {
    ...baseline,
    personal: {
      ...baseline.personal,
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
  await expect(
    page.getByText("Approved wording", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(proposedText, { exact: true })).toBeVisible();
  // The actual Profile form must preserve stable identities, nested authored
  // fields and literal policy values while editing an unrelated known field.
  const editedName = "Synthetic Browser Writer";
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
  await expect(page.getByText(proposedText, { exact: true })).toBeVisible();
});
