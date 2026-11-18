import { test, expect, json } from "../harness/fixtures.js";

type Settings = {
  revision: number;
  dailyBudgetUsd: number;
  workerActivitySlots: number;
  defaultProvider: string;
  providerModels: Record<string, string>;
};

test("Settings saves a budget before model setup, retains another pane's invalid draft, and checks connection readiness only on request", async ({
  api,
  app,
  page,
  allowRequestFailure,
}, testInfo) => {
  const settings = () => json<Settings>(api, "get", "/v1/settings");
  const initial = await settings();
  const providerCalls = () =>
    app.external.calls.filter(
      (call) => call.path === "/catalog" || call.path === "/model",
    );
  const initialCalls = providerCalls().length;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/settings/budgets");
  const sections = page.getByRole("navigation", {
    name: "Settings sections",
    exact: true,
  });
  const budget = page.getByRole("spinbutton", {
    name: "Daily LLM budget (USD)",
    exact: true,
  });
  await budget.fill("3.75");
  const budgetWrite = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/v1/settings" &&
      response.request().method() === "PATCH",
  );
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  expect((await budgetWrite).status()).toBe(200);
  await expect.poll(async () => (await settings()).dailyBudgetUsd).toBe(3.75);
  expect((await settings()).providerModels).toEqual(initial.providerModels);
  expect(providerCalls()).toHaveLength(initialCalls);
  await page.reload();
  await expect(budget).toHaveValue("3.75");

  await budget.fill("-1");
  await sections.getByRole("link", { name: "Automation", exact: true }).click();
  await page
    .locator("summary")
    .filter({ hasText: /^Runtime and provider limits$/ })
    .click();
  await expect(
    page.getByText(
      "Worker activity slot changes take effect after the worker restarts.",
      { exact: true },
    ),
  ).toBeVisible();
  const slots = initial.workerActivitySlots === 2 ? 3 : 2;
  await page
    .getByRole("spinbutton", { name: "Worker activity slots", exact: true })
    .fill(String(slots));
  const automationWrite = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/v1/settings" &&
      response.request().method() === "PATCH",
  );
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  expect((await automationWrite).status()).toBe(200);
  const afterAutomation = await settings();
  expect(afterAutomation).toMatchObject({
    dailyBudgetUsd: 3.75,
    workerActivitySlots: slots,
  });
  await sections.getByRole("link", { name: "Budgets", exact: true }).click();
  await expect(budget).toHaveValue("-1");
  await expect(
    page.getByRole("button", { name: "Save settings", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", {
      name: "Discard draft and load saved settings",
      exact: true,
    })
    .click();
  await expect(budget).toHaveValue("3.75");
  expect(await settings()).toEqual(afterAutomation);
  expect(providerCalls()).toHaveLength(initialCalls);

  await sections
    .getByRole("link", { name: "Connections", exact: true })
    .click();
  await expect(
    page.getByText(
      "Connection readiness has not been checked for the current settings. Checking may contact your providers.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText("Not checked", { exact: true })).toHaveCount(3);
  expect(providerCalls()).toHaveLength(initialCalls);
  // External provider metadata explicitly distinguishes configuration from
  // successful runtime access. The real provider service validates this data.
  app.external.setCatalog({
    providers: [
      { provider: "codex", configured: true, ready: false, models: [] },
      { provider: "claude", configured: false, ready: false, models: [] },
      { provider: "google", configured: false, ready: false, models: [] },
    ],
  });
  const reads: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "GET" &&
      ["/v1/credentials", "/v1/providers/status"].includes(path)
    )
      reads.push(path);
  });
  const checked = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/v1/providers/status" &&
      response.request().method() === "GET",
  );
  await page
    .getByRole("button", { name: "Check connections", exact: true })
    .click();
  const status = await checked;
  expect(status.status()).toBe(200);
  expect(
    (
      (await status.json()) as {
        providers: { provider: string; configured: boolean; ready: boolean }[];
      }
    ).providers,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        provider: "codex",
        configured: true,
        ready: false,
      }),
      expect.objectContaining({
        provider: "claude",
        configured: false,
        ready: false,
      }),
    ]),
  );
  await expect(
    page.getByText("Configured · verify model access", { exact: true }),
  ).toHaveCount(1);
  await expect(page.getByText("Ready", { exact: true })).toHaveCount(0);
  expect(reads).toEqual([
    "/v1/credentials",
    "/v1/providers/status",
    "/v1/credentials",
  ]);
  expect(
    providerCalls()
      .slice(initialCalls)
      .map((call) => call.path),
  ).toEqual(["/catalog"]);
  const liveHealth = await json<{ worker: { healthy: boolean } }>(
    api,
    "get",
    "/v1/health",
  );
  expect(liveHealth.worker.healthy).toBe(true);
  await testInfo.attach("settings-source-bound-readiness", {
    contentType: "image/png",
    body: await page.screenshot(),
  });
  const modelCatalog = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/v1/providers/models" &&
      response.request().method() === "GET",
  );
  await page
    .getByRole("button", { name: "Refresh model catalog", exact: true })
    .click();
  expect((await modelCatalog).status()).toBe(200);
  expect(
    providerCalls()
      .slice(initialCalls)
      .map((call) => call.path),
  ).toEqual(["/catalog", "/catalog"]);
  expect(app.external.calls.filter((call) => call.path === "/model")).toEqual(
    [],
  );
  expect(await settings()).toEqual(afterAutomation);
  const credentialsBefore = await json<{
    revision: number;
    credentials: { key: string; configured: boolean }[];
  }>(api, "get", "/v1/credentials");
  await page
    .getByRole("button", { name: "Configure Claude", exact: true })
    .click();
  const key = page.getByLabel("Anthropic API key (required)", { exact: true });
  const draftKey = "synthetic-owned-unsaved-provider-key";
  await key.fill(draftKey);
  await sections.getByRole("link", { name: "Appearance", exact: true }).click();
  await sections
    .getByRole("link", { name: "Connections", exact: true })
    .click();
  await expect(key).toHaveValue(draftKey);
  const main = page.getByRole("navigation", {
    name: "Main navigation",
    exact: true,
  });
  await main.getByRole("link", { name: "Jobs", exact: true }).click();
  const guard = page.getByRole("dialog", {
    name: "Unsaved connection credential",
    exact: true,
  });
  await expect(guard).toBeVisible();
  await guard
    .getByRole("button", { name: "Stay in Settings", exact: true })
    .click();
  await expect(key).toHaveValue(draftKey);
  expect(
    (await json<{ revision: number }>(api, "get", "/v1/credentials")).revision,
  ).toBe(credentialsBefore.revision);

  // The actual credential batch commits in the owned native-store helper;
  // sever only its acknowledgement, then require the local edit and guard.
  let savedStatus: number | undefined;
  await page.route(
    "**/v1/credentials/batch",
    async (route) => {
      const response = await route.fetch();
      savedStatus = response.status();
      await route.abort("failed");
    },
    { times: 1 },
  );
  const lost = page.waitForEvent("requestfailed", {
    predicate: (request) =>
      request.method() === "PATCH" &&
      new URL(request.url()).pathname === "/v1/credentials/batch",
  });
  await page
    .getByRole("button", { name: "Save Claude setup", exact: true })
    .click();
  const failed = await lost;
  allowRequestFailure(failed, "net::ERR_FAILED");
  expect(savedStatus).toBe(200);
  await expect(key).toHaveValue(draftKey);
  await expect(
    page.getByRole("alert").filter({
      hasText:
        /The credential change may have completed\. Your input remains unsaved/,
    }),
  ).toBeVisible();
  expect(
    (
      await json<{ credentials: { key: string; configured: boolean }[] }>(
        api,
        "get",
        "/v1/credentials",
      )
    ).credentials.find((item) => item.key === "ANTHROPIC_API_KEY")!.configured,
  ).toBe(true);
  await main.getByRole("link", { name: "Jobs", exact: true }).click();
  await expect(guard).toBeVisible();
  await guard
    .getByRole("button", { name: "Discard and leave", exact: true })
    .click();
  await expect(page).toHaveURL(/\/jobs(?:\?|$)/);
  await main.getByRole("link", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Configure Claude", exact: true })
    .click();
  await expect(key).toHaveValue("");
  await key.fill("synthetic-cleared-provider-draft");
  await key.fill("");
  await main.getByRole("link", { name: "Jobs", exact: true }).click();
  await expect(page).toHaveURL(/\/jobs(?:\?|$)/);
  await expect(guard).toHaveCount(0);
});
