import { test, expect, json, action, terminal } from "../harness/fixtures.js";

type Source = {
  sourceId: string;
  revision: number;
  state: string;
  consecutiveFailures: number;
  [key: string]: unknown;
};
type Digest = {
  blockedSources: {
    count: number;
    sources: { sourceId: string; consecutiveFailures: number }[];
  };
};

test("Jobs attention distinguishes deliberately inactive sources from quarantined or repeatedly failing sources without rewriting the registry", async ({
  api,
  app,
  page,
}, testInfo) => {
  const sources = () =>
    json<{ sources: Source[] }>(api, "get", "/v1/discovery/sources");
  const digest = () => json<Digest>(api, "get", "/v1/digest");
  const sourceId = "jobstreaming:linkedin";
  const original = (await sources()).sources;
  const prior = original.find((source) => source.sourceId === sourceId);
  await json(api, "post", "/v1/discovery/sources", {
    sourceId,
    displayName: "Synthetic controlled source",
    kind: "broad_board",
    state: "active",
    policyId: "broad_board_tolerated",
    adapterConfig: { board: "linkedin" },
    ...(prior ? { expectedRevision: prior.revision } : {}),
  });
  const settings = await json<{ revision: number }>(
    api,
    "get",
    "/v1/discovery/settings",
  );
  await json(api, "patch", "/v1/discovery/settings", {
    expectedRevision: settings.revision,
    queries: ["Synthetic source readiness engineer"],
    locations: [{ location: "Madrid", remote: false }],
    boards: ["linkedin"],
    resultsPerSite: 5,
    hoursOld: 0,
    newJobLimit: 5,
  });
  // Real worker runs retain real failed source receipts. No source health row is
  // inserted or replaced by the test harness.
  for (let failure = 1; failure <= 3; failure += 1) {
    const run = await action(api, "discovery.search", {});
    const provider = await app.external.next();
    expect(provider.path).toBe("/discovery");
    expect(provider.body["request"]).toMatchObject({
      query: "Synthetic source readiness engineer",
      sites: ["linkedin"],
    });
    provider.respond(
      { error: "controlled_external_provider_unavailable" },
      503,
    );
    expect((await terminal(api, run.runId))["status"]).toBe("failed");
    const source = (await sources()).sources.find(
      (item) => item.sourceId === sourceId,
    )!;
    expect(source.consecutiveFailures).toBe(failure);
    expect(
      (await digest()).blockedSources.sources.some(
        (item) => item.sourceId === sourceId,
      ),
    ).toBe(failure >= 3);
  }
  const failing = (await sources()).sources.find(
    (source) => source.sourceId === sourceId,
  )!;
  await json(
    api,
    "patch",
    `/v1/discovery/sources/${encodeURIComponent(sourceId)}/state`,
    {
      expectedRevision: failing.revision,
      state: "disabled",
      reason: "Synthetic explicit source deactivation.",
    },
  );
  const disabled = (await sources()).sources.find(
    (source) => source.sourceId === sourceId,
  )!;
  expect(disabled).toMatchObject({ state: "disabled", consecutiveFailures: 3 });
  expect((await digest()).blockedSources.count).toBe(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/jobs");
  await expect(
    page.getByRole("heading", { name: "Jobs", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Needs attention", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("sources normal", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText("healthy", { exact: true })).toHaveCount(0);
  expect(
    (await sources()).sources.find((source) => source.sourceId === sourceId),
  ).toEqual(disabled);

  await json(api, "post", "/v1/discovery/sources", {
    sourceId: "qa:quarantined",
    displayName: "Synthetic quarantined source",
    kind: "ats_api",
    state: "quarantined",
  });
  const snapshot = (await sources()).sources;
  const blocked = await digest();
  expect(blocked.blockedSources).toEqual({
    count: 1,
    sources: [
      expect.objectContaining({
        sourceId: "qa:quarantined",
        consecutiveFailures: 0,
      }),
    ],
  });
  await page.reload();
  const attention = page.getByRole("region", {
    name: "Needs attention",
    exact: true,
  });
  await expect(
    attention.getByRole("link", {
      name: "1 search source needs attention",
      exact: true,
    }),
  ).toHaveAttribute("href", "/discovery");
  await testInfo.attach("jobs-attention-quarantine-not-inactive", {
    contentType: "image/png",
    body: await page.screenshot(),
  });
  expect((await sources()).sources).toEqual(snapshot);
  await digest();
  expect((await sources()).sources).toEqual(snapshot);
  expect(app.external.calls.filter((call) => call.path === "/model")).toEqual(
    [],
  );
});
