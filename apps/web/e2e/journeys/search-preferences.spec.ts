import { test, expect, json } from "../harness/fixtures.js";
import { createBaseline, type Profile } from "./core-data.js";

type LocationBinding = {
  rowIndex: number;
  text: string;
  provider: "photon";
  placeId: string;
  displayName: string;
  longitude: number;
  latitude: number;
  selectedAt: string;
  provenance: "user_selected";
};
type PreferencesProfile = Omit<Profile, "profile"> & {
  profile: Profile["profile"] & {
    experience: {
      target_role: string;
      target_functions: string;
      target_locations: string;
      target_work_models: string;
      target_location_bindings: LocationBinding[];
    };
  };
};

test("search preferences insert and focus on Enter, autosave canonical targets, and bind only an explicitly selected valid Photon place", async ({
  api,
  app,
  page,
}, testInfo) => {
  await createBaseline(api);
  const photonRequests: { method: string; url: string; body: string | null }[] =
    [];
  let invalidCoordinates = false;
  await page.route("https://photon.komoot.io/api/**", async (route) => {
    const request = route.request();
    photonRequests.push({
      method: request.method(),
      url: request.url(),
      body: request.postData(),
    });
    const feature = {
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: invalidCoordinates ? [300, 95] : [-3.7038, 40.4168],
      },
      properties: {
        osm_type: "R",
        osm_id: 5326783 + photonRequests.length,
        name: "Madrid",
        state: "Community of Madrid",
        country: "Spain",
      },
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": app.baseURL },
      body: JSON.stringify({ features: [feature, feature] }),
    });
  });
  const callsBefore = app.external.calls.length;
  const canonical = () => json<PreferencesProfile>(api, "get", "/v1/profile");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/preferences");
  await expect(
    page.getByRole("heading", {
      name: "Search preferences",
      level: 1,
      exact: true,
    }),
  ).toBeVisible();
  const roles = page.getByRole("textbox", {
    name: "Target roles 1",
    exact: true,
  });
  await roles.fill("Synthetic Reliability Engineer");
  await roles.press("Enter");
  const secondRole = page.getByRole("textbox", {
    name: "Target roles 2",
    exact: true,
  });
  await expect(secondRole).toBeFocused();
  await secondRole.fill("Synthetic Platform Lead");
  const functions = page.getByRole("textbox", {
    name: "Functions 1",
    exact: true,
  });
  await functions.fill("Synthetic Platform Engineering");
  await functions.press("Enter");
  await expect(
    page.getByRole("textbox", { name: "Functions 2", exact: true }),
  ).toBeFocused();
  // Leave through the actual workspace controls before the autosave debounce;
  // the retained form must resume from its canonical saved base on return.
  const main = page.getByRole("navigation", {
    name: "Main navigation",
    exact: true,
  });
  await main.getByRole("link", { name: "Jobs", exact: true }).click();
  await main.getByRole("link", { name: "My profile", exact: true }).click();
  await page
    .getByRole("navigation", { name: "My profile sections", exact: true })
    .getByRole("link", { name: "Search preferences", exact: true })
    .click();
  await expect(roles).toHaveValue("Synthetic Reliability Engineer");
  await expect(secondRole).toHaveValue("Synthetic Platform Lead");
  await expect(functions).toHaveValue("Synthetic Platform Engineering");
  await expect(
    page.getByRole("button", { name: "Start search", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      "Wait for your Search preferences and search settings to finish saving.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect
    .poll(async () => (await canonical()).profile.experience.target_role)
    .toBe("Synthetic Reliability Engineer; Synthetic Platform Lead");
  await expect
    .poll(async () => (await canonical()).profile.experience.target_functions)
    .toBe("Synthetic Platform Engineering");
  await expect(roles).toHaveValue("Synthetic Reliability Engineer");
  await expect(secondRole).toHaveValue("Synthetic Platform Lead");
  await expect(functions).toHaveValue("Synthetic Platform Engineering");
  await expect(
    page
      .locator("form")
      .filter({ has: roles })
      .getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  expect(photonRequests).toEqual([]);
  await page.reload();
  await expect(roles).toHaveValue("Synthetic Reliability Engineer");
  await expect(secondRole).toHaveValue("Synthetic Platform Lead");
  await expect(functions).toHaveValue("Synthetic Platform Engineering");

  const searchLimit = page.getByRole("spinbutton", {
    name: "Maximum new jobs",
    exact: true,
  });
  await searchLimit.fill("7");
  await main.getByRole("link", { name: "Jobs", exact: true }).click();
  await main.getByRole("link", { name: "My profile", exact: true }).click();
  await page
    .getByRole("navigation", { name: "My profile sections", exact: true })
    .getByRole("link", { name: "Search preferences", exact: true })
    .click();
  await expect(searchLimit).toHaveValue("7");
  await expect
    .poll(
      async () =>
        (
          await json<{ settings: { newJobLimit: number } }>(
            api,
            "get",
            "/v1/discovery/settings",
          )
        ).settings.newJobLimit,
    )
    .toBe(7);
  await expect(searchLimit).toHaveValue("7");
  await expect(
    page.getByRole("button", { name: "Save search settings", exact: true }),
  ).toHaveCount(0);

  const location = page.getByRole("group", { name: "Location 1", exact: true });
  const text = location.getByRole("textbox", {
    name: "Target location 1",
    exact: true,
  });
  await text.fill("Madrid");
  await expect(location).toContainText("Unverified location.");
  expect(photonRequests).toEqual([]);
  await location
    .getByRole("button", { name: "Search map", exact: true })
    .click();
  const results = location.getByRole("group", {
    name: "Map results for location 1",
    exact: true,
  });
  const chosenName = "Madrid, Community of Madrid, Spain";
  await expect(results.getByRole("button")).toHaveCount(1);
  expect(
    (await canonical()).profile.experience.target_location_bindings ?? [],
  ).toEqual([]);
  expect(photonRequests).toHaveLength(1);
  const outbound = new URL(photonRequests[0]!.url);
  expect(photonRequests[0]!.method).toBe("GET");
  expect(photonRequests[0]!.body).toBeNull();
  expect(Object.fromEntries(outbound.searchParams)).toEqual({
    q: "Madrid",
    limit: "5",
  });
  expect(outbound.search).not.toContain("Synthetic");
  await results.getByRole("button", { name: chosenName, exact: true }).click();
  await location.getByRole("checkbox", { name: "Remote", exact: true }).check();
  await expect(location).toContainText(`Verified place · ${chosenName}`);
  await expect
    .poll(
      async () =>
        (await canonical()).profile.experience.target_location_bindings?.length,
    )
    .toBe(1);
  let saved = await canonical();
  expect(saved.profile.experience).toMatchObject({
    target_locations: chosenName,
    target_work_models: "remote",
  });
  const binding = saved.profile.experience.target_location_bindings[0]!;
  expect(binding).toMatchObject({
    rowIndex: 0,
    text: chosenName,
    displayName: chosenName,
    provider: "photon",
    placeId: "R:5326784",
    longitude: -3.7038,
    latitude: 40.4168,
    provenance: "user_selected",
  });
  expect(Number.isFinite(Date.parse(binding.selectedAt))).toBe(true);
  await page.reload();
  await expect(text).toHaveValue(chosenName);
  await expect(location).toContainText(`Verified place · ${chosenName}`);
  await expect(
    location.getByRole("checkbox", { name: "Remote", exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Add location", exact: true }).click();
  const secondLocation = page.getByRole("group", {
    name: "Location 2",
    exact: true,
  });
  await secondLocation
    .getByRole("textbox", { name: "Target location 2", exact: true })
    .fill("Madrid");
  await secondLocation
    .getByRole("button", { name: "Search map", exact: true })
    .click();
  await secondLocation
    .getByRole("group", { name: "Map results for location 2", exact: true })
    .getByRole("button", { name: chosenName, exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await canonical()).profile.experience.target_location_bindings.length,
    )
    .toBe(2);
  saved = await canonical();
  expect(saved.profile.experience.target_location_bindings).toEqual([
    binding,
    expect.objectContaining({
      rowIndex: 1,
      text: chosenName,
      placeId: "R:5326785",
    }),
  ]);
  const secondBinding = saved.profile.experience.target_location_bindings[1]!;
  await page.reload();
  await expect(location).toContainText(`Verified place · ${chosenName}`);
  await expect(secondLocation).toContainText(`Verified place · ${chosenName}`);
  await testInfo.attach("preferences-explicit-place", {
    contentType: "image/png",
    body: await page.screenshot(),
  });

  // Python independently refuses malformed coordinates and provider authority;
  // browser validation alone cannot protect direct writes to the public API.
  for (const forged of [
    { ...binding, latitude: 95 },
    { ...binding, provider: "forged" },
  ]) {
    const response = await api.patch("/v1/profile", {
      data: {
        expectedProfileVersion: saved.profileVersion,
        profile: {
          ...saved.profile,
          experience: {
            ...saved.profile.experience,
            target_location_bindings: [forged],
          },
        },
      },
    });
    expect(response.status(), await response.text()).toBe(400);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("invalid_profile");
    expect(await canonical()).toEqual(saved);
  }

  invalidCoordinates = true;
  await text.fill("Madrid changed text");
  await expect(location).toContainText("Unverified location.");
  await location
    .getByRole("button", { name: "Search map", exact: true })
    .click();
  await expect(location.getByRole("alert")).toContainText("unreadable result");
  await expect(results).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await canonical()).profile.experience.target_location_bindings,
    )
    .toEqual([secondBinding]);
  await expect
    .poll(async () => (await canonical()).profile.experience.target_locations)
    .toBe(`Madrid changed text; ${chosenName}`);
  expect(photonRequests).toHaveLength(3);
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

  const beforePlan = await canonical();
  const literalProfile = {
    ...beforePlan.profile,
    experience: {
      ...beforePlan.profile.experience,
      target_role: "Synthetic literal source-bound role",
      target_functions: "",
      target_specializations: "",
      target_track: "",
      target_seniority_floor: "",
    },
  };
  const literal = await json<PreferencesProfile>(api, "patch", "/v1/profile", {
    expectedProfileVersion: beforePlan.profileVersion,
    profile: literalProfile,
  });
  const planRequest = {
    force: false,
    operationId: "owned-preferences-literal-plan",
    expectedProfileVersion: literal.profileVersion,
  };
  const planned = await json<{
    accepted: { profileRevision: number };
    current: boolean;
  }>(api, "post", "/v1/discovery/target-search", planRequest);
  expect(planned.current).toBe(true);
  expect(planned.accepted.profileRevision).toBe(literal.profileVersion);
  await json<PreferencesProfile>(api, "patch", "/v1/profile", {
    expectedProfileVersion: literal.profileVersion,
    profile: {
      ...literal.profile,
      personal: {
        ...literal.profile.personal,
        full_name: "Synthetic newer saved Profile",
      },
    },
  });
  const stalePlan = await api.post("/v1/discovery/target-search", {
    data: planRequest,
  });
  expect(stalePlan.status(), await stalePlan.text()).toBe(409);
  expect(
    ((await stalePlan.json()) as { error: { code: string } }).error.code,
  ).toBe("target_profile_changed");
  expect(
    app.external.calls
      .slice(callsBefore)
      .filter((call) => call.path === "/model"),
  ).toEqual([]);
});
