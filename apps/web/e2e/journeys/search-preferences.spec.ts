import { test, expect, json, completed, terminal } from "../harness/fixtures.js";
import { baseline, createBaseline, createPosting, type Profile } from "./core-data.js";

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
  await test.step("the primary search action precedes authoring at desktop and phone widths", async () => {
    for (const width of [1643, 1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const launch = await page.getByRole("button", { name: "Start search", exact: true }).boundingBox();
      const authoring = await roles.boundingBox();
      expect(launch).not.toBeNull();
      expect(authoring).not.toBeNull();
      expect(launch!.y).toBeGreaterThanOrEqual(0);
      expect(launch!.y + launch!.height).toBeLessThan(750);
      expect(launch!.y + launch!.height).toBeLessThan(authoring!.y);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
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
  await expect(page.getByRole("button", { name: "Start search", exact: true })).toBeDisabled();
  await expect(page.getByText("Wait for your Search preferences and search settings to finish saving.", { exact: true })).toBeVisible();
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
  await expect(page.getByRole("button", { name: "Start search", exact: true })).toBeDisabled();
  await expect(page.getByText("Wait for your Search preferences and search settings to finish saving.", { exact: true })).toBeVisible();
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

  await test.step("context tools preserve drafts and save only their own changed settings", async () => {
    const settingsBefore = await json<{ settings: { boards: string[]; hoursOld: number; resultsPerSite: number; maxParallelFamilies: number } }>(api, "get", "/v1/discovery/settings");
    await page.getByText("Search plans, schedules and source behavior", { exact: true }).click();
    const tools = page.locator(".search-context-tools");
    const targets = tools.getByRole("region", { name: "Explicit discovery targets", exact: true });
    const targetsToggle = targets.getByRole("button", { name: /Explicit search targets/ });
    await expect(targetsToggle).toHaveAttribute("aria-expanded", "false");
    await targetsToggle.click();
    const literal = targets.getByRole("textbox", { name: "Add literal query", exact: true });
    await literal.fill("Synthetic independent query draft");
    await targetsToggle.click();
    await expect(literal).not.toBeVisible();
    await targetsToggle.click();
    await expect(literal).toHaveValue("Synthetic independent query draft");
    await literal.clear();

    const suggestions = tools.locator(".target-search-settings");
    const suggestionsToggle = suggestions.getByRole("button", { name: /Search preference suggestions/ });
    await suggestionsToggle.click();
    for (const width of [1643, 1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const action = suggestions.getByRole("button", { name: "Get suggestions for target roles", exact: true });
      const actionBounds = await action.boundingBox();
      const panelBounds = await suggestions.boundingBox();
      expect(actionBounds).not.toBeNull();
      expect(panelBounds).not.toBeNull();
      expect(actionBounds!.x).toBeGreaterThanOrEqual(panelBounds!.x);
      expect(actionBounds!.x + actionBounds!.width).toBeLessThanOrEqual(panelBounds!.x + panelBounds!.width);
      if (width === 390) {
        const heading = await suggestions.getByText("Evidence-backed target search suggestions", { exact: true }).boundingBox();
        expect(heading!.width).toBeGreaterThan(panelBounds!.width * .7);
      }
    }
    await suggestionsToggle.click();
    await page.setViewportSize({ width: 1440, height: 1000 });

    const runtime = tools.locator(".discovery-runtime-settings");
    const runtimeToggle = runtime.getByRole("button", { name: /Source behavior and schedules/ });
    await expect(runtimeToggle).toHaveAttribute("aria-expanded", "false");
    await runtimeToggle.click();
    await expect(runtime.getByRole("spinbutton", { name: "Results per board", exact: true })).toHaveCount(0);
    await expect(runtime.getByRole("spinbutton", { name: "Posting lookback hours", exact: true })).toHaveCount(0);
    await expect(runtime.getByRole("group", { name: "Job boards", exact: true })).toHaveCount(0);
    const parallel = settingsBefore.settings.maxParallelFamilies === 2 ? 1 : 2;
    await runtime.getByRole("spinbutton", { name: "Parallel source families", exact: true }).fill(String(parallel));
    const age = settingsBefore.settings.hoursOld === 48 ? 72 : 48;
    await page.getByRole("spinbutton", { name: "Posting age", exact: true }).fill(String(age));
    await expect.poll(async () => (await json<{ settings: { hoursOld: number } }>(api, "get", "/v1/discovery/settings")).settings.hoursOld).toBe(age);
    await runtime.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect.poll(async () => (await json<{ settings: { maxParallelFamilies: number } }>(api, "get", "/v1/discovery/settings")).settings.maxParallelFamilies).toBe(parallel);
    const current = await json<{ settings: { boards: string[]; hoursOld: number; resultsPerSite: number } }>(api, "get", "/v1/discovery/settings");
    expect(current.settings).toMatchObject({ boards: settingsBefore.settings.boards, hoursOld: age, resultsPerSite: settingsBefore.settings.resultsPerSite });
    expect((await json<{ runs: unknown[] }>(api, "get", "/v1/discovery/runs")).runs).toEqual([]);
    await runtimeToggle.click();
    await targetsToggle.click();
    await page.getByText("Search plans, schedules and source behavior", { exact: true }).click();
  });

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


async function savedSearch(api: Parameters<typeof createBaseline>[0]) {
  const { profile } = await createBaseline(api, {
    ...baseline,
    experience: { target_role: "Synthetic Reliability Engineer", target_locations: "Madrid", target_work_models: "remote" },
  });
  const before = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", {
    expectedRevision: before.revision, boards: ["linkedin"], hoursOld: 0, newJobLimit: 5, resultsPerSite: 5,
  });
  return profile;
}

function searchPosting(id: string) {
  return { job_key: id, url: `https://example.com/jobs/${id}`, title: `Synthetic ${id} Engineer`,
    company: "Synthetic Hiring Company", description: "Maintain durable workflows.", location: "Madrid" };
}

test("Jobs starts saved searches directly, preserves live progress across navigation and tabs, and displays canonical completion", async ({ api, app, page }, testInfo) => {
  const profile = await savedSearch(api);
  await createPosting(api, "previously-saved");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/jobs");
  const start = page.getByRole("button", { name: "Start search", exact: true });
  const progress = page.getByRole("region", { name: "Job search progress", exact: true });
  await expect(start).toBeEnabled();
  await expect(page.getByRole("link", { name: "Synthetic Reliability Engineer", exact: true })).toBeVisible();
  const beforeSearch = new URL(page.url()).search;
  expect((await json<{ runs: unknown[] }>(api, "get", "/v1/action-runs?action=discovery.search")).runs).toEqual([]);
  await start.evaluate(async (element) => { await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined))); });
  await testInfo.attach("jobs-search-ready-desktop", { contentType: "image/png", body: await page.screenshot() });
  const queued = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/v1/actions/discovery.search");
  await start.click();
  const receipt = await queued;
  expect(receipt.status()).toBe(202);
  expect(receipt.request().postDataJSON()).toEqual({ queries: [], locations: [], expectedProfileVersion: profile.profileVersion });
  const { runId } = await receipt.json() as { runId: string };
  const first = await app.external.next();
  expect(first.path).toBe("/discovery");
  expect(first.body["request"]).toMatchObject({ query: "Synthetic Reliability Engineer", location: "Madrid", remote_only: true, sites: ["linkedin"] });
  first.respond({ jobs: [searchPosting("Platform"), searchPosting("Infrastructure")], cursor: "next-page", complete: false });
  const next = await app.external.next();
  expect(next.body["runId"]).toBe(runId);
  await expect(progress.getByRole("progressbar")).toBeVisible();
  await expect(progress.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  await expect(progress).toContainText("2 new jobs");
  await expect(page.getByRole("link", { name: "Synthetic Platform Engineer", exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/jobs");
  expect(new URL(page.url()).search).toBe(beforeSearch);
  await testInfo.attach("jobs-search-running-desktop", { contentType: "image/png", body: await page.screenshot() });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(progress.getByRole("button", { name: "Request stop", exact: true })).toBeVisible();
  await testInfo.attach("jobs-search-running-phone", { contentType: "image/png", body: await page.screenshot() });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await expect(progress).toContainText("2 new jobs");
  await page.getByRole("link", { name: "Search preferences", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start search", exact: true })).toBeDisabled();
  await page.getByRole("link", { name: "Back to jobs", exact: true }).click();
  await expect(progress.getByRole("progressbar")).toBeVisible();
  const peer = await page.context().newPage();
  try {
    await peer.goto(app.baseURL + "/jobs");
    await expect(peer.getByRole("region", { name: "Job search progress", exact: true })).toContainText("2 new jobs");
    await expect(peer.getByRole("button", { name: "Start search", exact: true })).toBeDisabled();
  } finally { await peer.close(); }
  expect((await json<{ runs: { runId: string }[] }>(api, "get", "/v1/action-runs?action=discovery.search")).runs.map((row) => row.runId)).toEqual([runId]);
  next.respond({ jobs: [searchPosting("Systems")], cursor: null, complete: true });
  await completed(api, runId);
  await expect(progress).toContainText("Search completed");
  await expect(progress).toContainText("3 new jobs");
  await expect(progress.getByRole("progressbar")).toHaveCount(0);
  await expect(start).toBeEnabled();
  await expect(page.getByRole("link", { name: "Synthetic Systems Engineer", exact: true })).toBeVisible();
  await start.evaluate(async (element) => { await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined))); });
  await testInfo.attach("jobs-search-completed-desktop", { contentType: "image/png", body: await page.screenshot() });
  expect(app.external.calls.filter((call) => call.path === "/model")).toHaveLength(0);
});

test("Jobs reconciles a lost search acknowledgement without duplicate work and stops the exact active search", async ({ api, app, page, allowRequestFailure }) => {
  await savedSearch(api);
  await page.goto("/jobs");
  const start = page.getByRole("button", { name: "Start search", exact: true });
  await expect(start).toBeEnabled();
  let admittedId = "";
  await page.route("**/v1/actions/discovery.search", async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    admittedId = ((await response.json()) as { runId: string }).runId;
    const failed = page.waitForEvent("requestfailed", { predicate: (request) => request === route.request() });
    await route.abort("failed");
    allowRequestFailure(await failed, "net::ERR_FAILED");
  }, { times: 1 });
  await start.click();
  const provider = await app.external.next();
  await expect.poll(() => admittedId).not.toBe("");
  expect(provider.body["runId"]).toBe(admittedId);
  await page.reload();
  const progress = page.getByRole("region", { name: "Job search progress", exact: true });
  await expect(progress.getByRole("progressbar")).toBeVisible();
  await expect(start).toBeDisabled();
  const stopping = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/v1/action-runs/${admittedId}/cancel`);
  await progress.getByRole("button", { name: "Request stop", exact: true }).click();
  const stopped = await stopping;
  expect(stopped.status()).toBe(200);
  expect(await stopped.json()).toMatchObject({ runId: admittedId, cancellationRequested: true });
  // Keep the source pending until cancellation settles; releasing a successful
  // final page immediately can legitimately win the completion/cancel race.
  expect((await terminal(api, admittedId)).status).toBe("cancelled");
  provider.respond({ jobs: [], cursor: null, complete: true });
  await expect(progress).toContainText("Search cancelled");
  await expect(start).toBeEnabled();
  expect((await json<{ runs: { runId: string }[] }>(api, "get", "/v1/action-runs?action=discovery.search")).runs.map((row) => row.runId)).toEqual([admittedId]);
  expect(app.external.calls.filter((call) => call.path === "/discovery")).toHaveLength(1);
  expect(app.external.calls.filter((call) => call.path === "/model")).toHaveLength(0);
});

test("simultaneous Jobs searches from two tabs admit one run and recover the refused tab", async ({ api, app, page, allowResponseError }) => {
  await savedSearch(api);
  await page.goto("/jobs");
  const peer = await page.context().newPage();
  try {
    await peer.goto(app.baseURL + "/jobs");
    const start = page.getByRole("button", { name: "Start search", exact: true });
    const peerStart = peer.getByRole("button", { name: "Start search", exact: true });
    await expect(start).toBeEnabled();
    await expect(peerStart).toBeEnabled();
    // Both real preflight reads finish before either genuine admission request
    // reaches the application. No first-party response or domain state is faked.
    const held: import("@playwright/test").Route[] = [];
    await page.context().route("**/v1/actions/discovery.search", async (route) => { held.push(route); });
    const predicate = (response: import("@playwright/test").Response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/v1/actions/discovery.search";
    const replies = [page.waitForResponse(predicate), peer.waitForResponse(predicate)];
    await Promise.all([start.click(), peerStart.click()]);
    await expect.poll(() => held.length).toBe(2);
    await Promise.all(held.map((route) => route.continue()));
    const responses = await Promise.all(replies);
    expect(responses.map((response) => response.status()).sort()).toEqual([202, 409]);
    const refused = responses.find((response) => response.status() === 409)!;
    await allowResponseError(refused, { method: "POST", status: 409, code: "action_scope_busy" });
    const accepted = responses.find((response) => response.status() === 202)!;
    const { runId } = await accepted.json() as { runId: string };
    const provider = await app.external.next();
    expect(provider.body["runId"]).toBe(runId);
    await expect(start).toBeDisabled();
    await expect(peerStart).toBeDisabled();
    for (const tab of [page, peer]) await expect(tab.getByRole("region", { name: "Job search progress", exact: true }).getByRole("progressbar")).toBeVisible();
    provider.respond({ jobs: [], cursor: null, complete: true });
    await completed(api, runId);
    await expect(start).toBeEnabled();
    await expect(peerStart).toBeEnabled();
    expect((await json<{ runs: { runId: string }[] }>(api, "get", "/v1/action-runs?action=discovery.search")).runs.map((row) => row.runId)).toEqual([runId]);
    expect(app.external.calls.filter((call) => call.path === "/discovery")).toHaveLength(1);
  } finally { await peer.close(); }
});
