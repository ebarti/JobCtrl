import { randomUUID } from "node:crypto";

import { test, expect, json } from "../harness/fixtures.js";
import { type Library, type Profile } from "./core-data.js";
import { createScoredFit, type FitState } from "./fit-data.js";

type Association = {
  association_id: string;
  revision: number;
  requirement_id: string;
  requirement_revision: number;
  achievement_id: string;
  role_id: string;
  achievement_source_refs: { source_id: string; revision: number }[];
  wording: {
    variant_id: string;
    variant_revision: number;
    exact_text: string;
    source_refs: { source_id: string; revision: number }[];
  } | null;
  state: "active" | "removed";
  origin: "user";
  assessment_status: "unassessed";
  current: boolean;
  stale_reasons: string[];
};
type RequirementLibrary = {
  profile_revision: number;
  catalog_revision: number;
  requirements: {
    requirement_id: string;
    revision: number;
    definition: string;
    assessment: Record<string, unknown> | null;
    coverage: unknown[];
    associations: Association[];
  }[];
};

test("manual requirement links preserve many-to-many intent, exact wording pins and stale history without granting assessment or coverage", async ({
  api,
  app,
  page,
}, testInfo) => {
  const seed = await createScoredFit(api, app, "manual-requirement-library", {
    twoRequirements: true,
  });
  const library = () =>
    json<RequirementLibrary>(api, "get", "/v1/fit/requirement-library");
  const before = await library();
  const profileBefore = await json<Profile>(api, "get", "/v1/profile");
  const wordingBefore = await json<Library>(api, "get", "/v1/profile/wording");
  const fitBefore = await json<FitState>(
    api,
    "get",
    `/v1/jobs/${seed.posting.job_id}/fit`,
  );
  const first = before.requirements[0]!;
  const second = before.requirements[1]!;
  const firstAchievement = wordingBefore.roles[0]!.achievements[0]!;
  const secondAchievement = wordingBefore.roles[0]!.achievements[1]!;
  const thirdAchievement = wordingBefore.roles[1]!.achievements[0]!;
  const variant = wordingBefore.variants.find(
    (row) => row.variant_id === thirdAchievement.baseline_variant_id,
  )!;
  const startedCalls = app.external.calls.length;

  const body = (
    requirement: typeof first,
    achievement: typeof thirdAchievement,
    exactWording = false,
  ) => ({
    association_id: randomUUID(),
    profile_id: "default",
    expected_profile_revision: before.profile_revision,
    requirement_id: requirement.requirement_id,
    requirement_revision: requirement.revision,
    achievement_id: achievement.achievement_id,
    achievement_source_refs: achievement.source_refs,
    wording: exactWording
      ? {
          variant_id: variant.variant_id,
          variant_revision: variant.revision,
          exact_text: variant.text,
          source_refs: variant.source_refs,
        }
      : null,
  });

  // A requirement may link to several achievements, and one achievement may
  // link to several requirements. These authored links do not judge meaning.
  const requests = [
    body(first, thirdAchievement),
    body(second, thirdAchievement),
    body(first, secondAchievement),
  ];
  const created: Association[] = [];
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(
    `/requirements?requirement=${encodeURIComponent(first.requirement_id)}`,
  );
  await page
    .getByRole("button", { name: "Link achievement", exact: true })
    .click();
  const picker = page.getByRole("dialog", {
    name: "Link an achievement",
    exact: true,
  });
  await picker
    .getByRole("group", { name: "Choose an achievement", exact: true })
    .getByRole("button")
    .filter({
      hasText: profileBefore.profile.resume.experience_entries[1]!.bullets[0]!,
    })
    .click();
  const linkSaved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/v1/fit/associations" &&
      response.request().method() === "POST",
  );
  await picker.getByRole("button", { name: "Save link", exact: true }).click();
  const linkResponse = await linkSaved;
  expect(linkResponse.status()).toBe(200);
  requests[0] = linkResponse.request().postDataJSON() as ReturnType<
    typeof body
  >;
  created.push((await linkResponse.json()) as Association);
  await expect(picker).toHaveCount(0);
  const filter = page.getByRole("textbox", {
    name: "Find a requirement",
    exact: true,
  });
  await filter.fill(first.definition);
  const linkedAchievement = page
    .locator(".requirement-achievement")
    .filter({
      has: page.getByText(
        profileBefore.profile.resume.experience_entries[1]!.bullets[0]!,
        { exact: true },
      ),
    });
  await linkedAchievement
    .getByRole("button", { name: "Open achievement →", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Experience", level: 1, exact: true }),
  ).toBeVisible();
  const profileContext = new URL(page.url()).searchParams;
  expect(profileContext.get("roleId")).toBe(wordingBefore.roles[1]!.role_id);
  expect(profileContext.get("achievementId")).toBe(
    thirdAchievement.achievement_id,
  );
  expect(profileContext.get("returnRequirement")).toBe(first.requirement_id);
  expect(profileContext.get("returnRequirementsFilter")).toBe(first.definition);
  await expect(
    page
      .getByRole("navigation", { name: "Career roles", exact: true })
      .getByRole("button")
      .filter({ hasText: "Synthetic Earlier Company" }),
  ).toHaveAttribute("aria-current", "true");
  await page.getByRole("link", { name: /Back to requirements$/ }).click();
  await expect(filter).toHaveValue(first.definition);
  expect(new URL(page.url()).searchParams.get("requirement")).toBe(
    first.requirement_id,
  );
  await page
    .locator("summary")
    .filter({ hasText: /^Source history and posting references$/ })
    .click();
  await page
    .getByRole("link", { name: "Open source job", exact: true })
    .click();
  await expect(
    page.getByRole("main", { name: "Job details", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`/jobs/${seed.posting.job_id}`);
  await page
    .getByRole("button", { name: "Back to requirements", exact: true })
    .click();
  await expect(filter).toHaveValue(first.definition);
  expect(new URL(page.url()).searchParams.get("requirement")).toBe(
    first.requirement_id,
  );
  for (const request of requests.slice(1))
    created.push(
      await json<Association>(api, "post", "/v1/fit/associations", request),
    );
  const duplicate = await api.post("/v1/fit/associations", {
    data: body(second, thirdAchievement, true),
  });
  expect(duplicate.status()).toBe(409);
  const pinnedRequest = {
    ...body(second, thirdAchievement, true),
    association_id: requests[1]!.association_id,
    expected_revision: created[1]!.revision,
  };
  const revisionPath = `/v1/fit/associations/${pinnedRequest.association_id}/revisions`;
  const pinned = await json<Association>(
    api,
    "post",
    revisionPath,
    pinnedRequest,
  );
  for (const row of created)
    expect(row).toMatchObject({
      origin: "user",
      assessment_status: "unassessed",
      state: "active",
      current: true,
      revision: 1,
    });
  expect(pinned.wording).toEqual(pinnedRequest.wording);
  expect(pinned.revision).toBe(2);
  const replay = await json<Association>(
    api,
    "post",
    revisionPath,
    pinnedRequest,
  );
  expect(replay).toEqual(pinned);
  const changedReplay = await api.post(revisionPath, {
    data: { ...pinnedRequest, wording: null },
  });
  expect(changedReplay.status()).toBe(409);

  const invalid = [
    {
      ...body(first, thirdAchievement),
      expected_profile_revision: before.profile_revision + 1,
    },
    {
      ...body(first, thirdAchievement),
      requirement_revision: first.revision + 1,
    },
    {
      ...body(first, thirdAchievement),
      achievement_source_refs: thirdAchievement.source_refs.map((row) => ({
        ...row,
        revision: row.revision + 1,
      })),
    },
    { ...body(first, firstAchievement, true) },
    {
      ...body(first, thirdAchievement, true),
      wording: {
        ...pinnedRequest.wording!,
        exact_text: `${variant.text} Changed.`,
      },
    },
    {
      ...body(first, thirdAchievement, true),
      wording: {
        ...pinnedRequest.wording!,
        variant_revision: variant.revision + 1,
      },
    },
  ];
  for (const request of invalid) {
    const response = await api.post("/v1/fit/associations", { data: request });
    expect(response.status(), await response.text()).toBe(409);
  }

  const linked = await library();
  expect(linked.requirements.flatMap((row) => row.associations)).toHaveLength(
    3,
  );
  expect(
    linked.requirements.find(
      (row) => row.requirement_id === first.requirement_id,
    )!.associations,
  ).toHaveLength(2);
  expect(
    linked.requirements.find(
      (row) => row.requirement_id === second.requirement_id,
    )!.associations,
  ).toHaveLength(1);
  expect(
    linked.requirements.map((row) => ({
      id: row.requirement_id,
      assessment: row.assessment,
      coverage: row.coverage,
    })),
  ).toEqual(
    before.requirements.map((row) => ({
      id: row.requirement_id,
      assessment: row.assessment,
      coverage: row.coverage,
    })),
  );
  expect(
    await json<FitState>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`),
  ).toEqual(fitBefore);
  expect(await json<Profile>(api, "get", "/v1/profile")).toEqual(profileBefore);
  expect(await json<Library>(api, "get", "/v1/profile/wording")).toEqual(
    wordingBefore,
  );

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(
    `/requirements?requirement=${encodeURIComponent(second.requirement_id)}`,
  );
  await expect(
    page.getByRole("heading", { name: "Requirements", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Your link · unassessed", { exact: true }).first(),
  ).toBeVisible();
  await testInfo.attach("requirements-manual-links", {
    contentType: "image/png",
    body: await page.screenshot(),
  });

  // Distinct changes reviewing one revision admit exactly one writer. Identical
  // lost-success requests are independently covered by the replay assertions.
  const revisionLibrary = await json<Library>(
    api,
    "post",
    "/v1/profile/wording",
    {
      expectedProfileVersion: before.profile_revision,
      achievementId: thirdAchievement.achievement_id,
      text: "Built a versioned import tool and kept a visible recovery record.",
      sourceRefs: thirdAchievement.source_refs,
    },
  );
  const revisionVariant = revisionLibrary.variants.find(
    (row) =>
      row.achievement_id === thirdAchievement.achievement_id &&
      row.status === "pending",
  )!;
  const nextBindings = [
    null,
    {
      variant_id: revisionVariant.variant_id,
      variant_revision: revisionVariant.revision,
      exact_text: revisionVariant.text,
      source_refs: revisionVariant.source_refs,
    },
  ];
  const races = await Promise.all(
    nextBindings.map((wording) =>
      api.post(revisionPath, {
        data: {
          ...pinnedRequest,
          expected_profile_revision: revisionLibrary.profileVersion,
          expected_revision: pinned.revision,
          wording,
        },
      }),
    ),
  );
  expect(races.map((response) => response.status()).sort()).toEqual([200, 409]);
  const revised = (await races
    .find((response) => response.status() === 200)!
    .json()) as Association;
  expect(revised).toMatchObject({
    association_id: pinned.association_id,
    revision: 3,
    state: "active",
  });
  const removed = await json<Association>(
    api,
    "post",
    `/v1/fit/associations/${pinned.association_id}/state`,
    {
      profile_id: "default",
      expected_revision: revised.revision,
      state: "removed",
    },
  );
  expect(removed.revision).toBe(4);

  // A later source edit cannot silently repin an association on restoration.
  const editedProfile = structuredClone(profileBefore.profile);
  editedProfile.resume.experience_entries[1]!.bullets[0] =
    "Built a versioned import tool with recorded recovery and review ownership.";
  await json<Profile>(api, "patch", "/v1/profile", {
    expectedProfileVersion: revisionLibrary.profileVersion,
    profile: editedProfile,
  });
  const restored = await json<Association>(
    api,
    "post",
    `/v1/fit/associations/${pinned.association_id}/state`,
    {
      profile_id: "default",
      expected_revision: removed.revision,
      state: "active",
    },
  );
  expect(restored).toMatchObject({
    association_id: pinned.association_id,
    revision: 5,
    state: "active",
    current: false,
    assessment_status: "unassessed",
  });
  expect(restored.stale_reasons.length).toBeGreaterThan(0);
  expect(restored.achievement_source_refs).toEqual(
    revised.achievement_source_refs,
  );
  expect(restored.wording).toEqual(revised.wording);
  const history = await json<{ total: number; rows: Association[] }>(
    api,
    "get",
    `/v1/fit/associations/${pinned.association_id}/history?limit=2&offset=0`,
  );
  expect(history.total).toBe(5);
  expect(history.rows).toHaveLength(2);
  expect(history.rows.map((row) => row.revision)).toEqual([5, 4]);
  const priorPins = await json<{ rows: Association[] }>(
    api,
    "get",
    `/v1/fit/associations/${pinned.association_id}/history?limit=5&offset=0`,
  );
  expect(
    priorPins.rows.find((row) => row.revision === pinned.revision)!.wording,
  ).toEqual(pinned.wording);
  await page.reload();
  await expect(
    page
      .getByText("Your link · unassessed · needs review", { exact: true })
      .first(),
  ).toBeVisible();
  expect(
    app.external.calls
      .slice(startedCalls)
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
