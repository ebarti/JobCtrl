import { test, expect, json, completed } from "../harness/fixtures.js";

test("a lost preparation admission is reconciled after reload without starting it twice", async ({
  app,
  api,
  page,
  allowRequestFailure,
}) => {
  const settings = await json<{ revision: number }>(
    api,
    "get",
    "/v1/discovery/settings",
  );
  await json(api, "patch", "/v1/discovery/settings", {
    expectedRevision: settings.revision,
    queries: ["Synthetic recovery engineer"],
    locations: [{ location: "Madrid", remote: false }],
    boards: ["linkedin"],
    resultsPerSite: 5,
    hoursOld: 0,
    newJobLimit: 5,
  });

  await page.goto("/pipelines");
  const controls = page.getByRole("region", { name: "Pipeline controls" });
  await expect(
    page.getByRole("heading", { name: "Start preparation" }),
  ).toBeVisible();
  await controls.getByLabel("Maximum jobs").fill("1");

  // Forward the actual browser request unchanged to Python. Only after its
  // real 202 is observed, sever delivery of that response to the browser.
  let admission: { status: number; body: { runId?: string } } | undefined;
  await page.route(
    "**/v1/actions/preparation.run",
    async (route) => {
      const response = await route.fetch();
      admission = {
        status: response.status(),
        body: (await response.json()) as { runId?: string },
      };
      await route.abort("failed");
    },
    { times: 1 },
  );
  const isAdmission = (request: import("@playwright/test").Request) =>
    request.method() === "POST" &&
    new URL(request.url()).pathname === "/v1/actions/preparation.run";
  const sent = page.waitForRequest(isAdmission);
  const dropped = page.waitForEvent("requestfailed", {
    predicate: isAdmission,
  });
  await controls.getByRole("button", { name: "Start work" }).click();
  const request = await sent;
  const failed = await dropped;
  expect(failed).toBe(request);
  expect(failed.failure()?.errorText).toContain("ERR_FAILED");
  allowRequestFailure(failed, "net::ERR_FAILED");
  expect(admission?.status).toBe(202);
  const runId = admission?.body.runId;
  expect(runId).toBeTruthy();
  const requestId = request.headers()["idempotency-key"];
  expect(requestId).toBeTruthy();
  expect(request.postDataJSON()).toMatchObject({
    recipe: "discover",
    scope: "pending",
    limit: 1,
  });

  // The held provider proves that the actual admitted worker is still active
  // while the browser reloads and checks its recorded request identity.
  const provider = await app.external.next();
  expect(provider.path).toBe("/discovery");
  expect(provider.body["request"]).toMatchObject({
    query: "Synthetic recovery engineer",
    location: "Madrid",
  });
  const storageKey = `jobctrl:request-recovery:local:${encodeURIComponent(JSON.stringify(["local", "preparation.run", "preparation"]))}`;
  const saved = await page.evaluate(
    (key) => sessionStorage.getItem(key),
    storageKey,
  );
  expect(saved).toBeTruthy();
  const identity = JSON.parse(saved!) as Record<string, unknown>;
  expect(identity).toMatchObject({
    operation: "preparation.run",
    requestId,
    version: 1,
  });
  expect(identity["fingerprint"]).toMatch(/^[a-f0-9]{64}$/);
  expect(Object.keys(identity).sort()).toEqual(
    [
      "databaseInstanceId",
      "fingerprint",
      "operation",
      "requestId",
      "version",
      "workspaceId",
    ].sort(),
  );
  expect(saved).not.toContain("Synthetic recovery engineer");

  await page.reload();
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), storageKey),
  ).toBe(saved);
  const notice = controls.getByRole("alert").filter({
    hasText: "A previous preparation request needs review",
  });
  await expect(notice).toContainText(`run ${runId}`);
  await expect(notice).toContainText("Recorded status: running");
  await expect(
    controls.getByRole("button", { name: "Retry the same request" }),
  ).toBeDisabled();
  const cohort = page.getByRole("region", { name: "Preparation cohort" });
  await expect(cohort.getByRole("combobox", { name: "Run" })).toContainText(
    runId!,
  );
  await expect(cohort.getByText(/Recorded status: running/)).toBeVisible();
  await expect(
    cohort.getByText(/Recorded target job IDs: none recorded/),
  ).toBeVisible();
  await expect(
    cohort.getByText("Unavailable · 0 matching samples."),
  ).toBeVisible();
  await notice
    .getByRole("button", { name: "Check previous preparation" })
    .click();
  await expect(controls.getByRole("status")).toContainText(
    `Previous request ${runId} is recorded as running. Its admission has been reconciled.`,
  );
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), storageKey),
  ).toBeNull();
  await expect(
    controls.getByRole("button", { name: "Start work" }),
  ).toBeEnabled();

  provider.respond({ jobs: [], cursor: null, complete: true });
  await completed(api, runId!);
  expect(
    app.external.calls.filter((call) => call.path === "/discovery"),
  ).toHaveLength(1);
  const recorded = await json<{ runId: string; recipe: string }>(
    api,
    "get",
    `/v1/preparation/runs/${runId}`,
  );
  expect(recorded).toMatchObject({ runId, recipe: "discover" });
});
