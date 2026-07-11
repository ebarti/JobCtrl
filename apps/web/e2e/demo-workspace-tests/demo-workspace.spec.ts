import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";

import type {
  DemoWorkspaceInitialization,
  DemoWorkspaceSnapshot,
} from "../../src/demo/workspace/contracts.js";
import type { DemoWorkspaceRepository } from "../../src/demo/workspace/DemoWorkspaceRepository.js";

const MODULE_URLS = {
  repository: "/src/demo/workspace/DemoWorkspaceRepository.ts",
  storage: "/src/demo/workspace/storage.ts",
  eventStream: "/src/demo/workspace/DemoWorkspaceEventStreamAdapter.ts",
} as const;
const STATIC_HOST = "/demo/source-preview.html";

const scenarioTest = test.extend<{ demoNetworkBoundary: void }>({
  demoNetworkBoundary: [
    async ({ baseURL, context }, use) => {
      if (!baseURL) throw new Error("Demo Playwright baseURL is required.");
      const demoOrigin = new URL(baseURL).origin;
      const forbiddenRequests: string[] = [];
      const guard = async (route: Route) => {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.origin === demoOrigin && requestUrl.pathname === "/api/demo-consent") {
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({ choice: "granted", version: "v1" }),
          });
          return;
        }
        if (
          requestUrl.origin === demoOrigin &&
          (requestUrl.pathname === "/api/demo-health" ||
            requestUrl.pathname === "/api/demo-telemetry")
        ) {
          await route.fulfill({ status: 204, body: "" });
          return;
        }
        const forbidden =
          requestUrl.pathname === "/v1" ||
          requestUrl.pathname === "/v1/events/stream" ||
          requestUrl.pathname.startsWith("/v1/") ||
          requestUrl.origin !== demoOrigin;
        if (forbidden) {
          forbiddenRequests.push(route.request().url());
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
      };
      await context.route("**/*", guard);
      try {
        await use();
      } finally {
        await context.unroute("**/*", guard);
        expect(
          forbiddenRequests,
          "demo journeys must not request the product API, SSE, or an external origin",
        ).toEqual([]);
      }
    },
    { auto: true },
  ],
});

declare global {
  interface Window {
    __jobctrlDemoWorkspace?: DemoWorkspaceRepository;
    __jobctrlDemoOpenedUrls?: string[];
  }
}

async function initializeWorkspace(
  page: Page,
): Promise<DemoWorkspaceInitialization> {
  return page.evaluate(async (moduleUrls) => {
    const [repositoryModule, storageModule] = await Promise.all([
      import(moduleUrls.repository),
      import(moduleUrls.storage),
    ]);
    const workspace = new repositoryModule.DemoWorkspaceRepository({
      store: new storageModule.IndexedDbDemoWorkspaceStore(),
    });
    window.__jobctrlDemoWorkspace = workspace;
    return workspace.initialize();
  }, MODULE_URLS);
}

async function snapshot(page: Page): Promise<DemoWorkspaceSnapshot> {
  return page.evaluate(async () => {
    if (!window.__jobctrlDemoWorkspace)
      throw new Error("workspace not initialized");
    return window.__jobctrlDemoWorkspace.snapshot();
  });
}

async function resetEpoch(page: Page): Promise<number> {
  return page.evaluate(async (moduleUrls) => {
    const [repositoryModule, storageModule] = await Promise.all([
      import(moduleUrls.repository),
      import(moduleUrls.storage),
    ]);
    const workspace = new repositoryModule.DemoWorkspaceRepository({
      store: new storageModule.IndexedDbDemoWorkspaceStore(),
    });
    await workspace.initialize();
    const value = (await workspace.snapshot()).resetEpoch;
    workspace.dispose();
    return value;
  }, MODULE_URLS);
}

function jobRow(page: Page, title: string): Locator {
  return page.getByRole("row").filter({
    has: page.getByText(title, { exact: true }),
  });
}

async function expectJobState(
  page: Page,
  title: string,
  state: "queued" | "running" | "failed" | "succeeded",
  timeout = 3_000,
): Promise<void> {
  await expect
    .poll(() => jobRow(page, title).innerText(), {
      intervals: [10, 20, 30, 50, 100],
      timeout,
    })
    .toMatch(new RegExp(`\\b${state}\\b`, "i"));
}

async function receiptCount(page: Page): Promise<number> {
  const summary = page.getByText(/^Receipt history \(\d+\)$/).first();
  await expect(summary).toBeVisible();
  const match = /\((\d+)\)/.exec((await summary.textContent()) ?? "");
  if (!match) throw new Error("Simulation receipt count was not rendered.");
  return Number(match[1]);
}

async function expectReceiptCount(page: Page, count: number): Promise<void> {
  await expect.poll(() => receiptCount(page)).toBe(count);
}

async function latestReceipt(page: Page): Promise<Locator> {
  const region = page.getByRole("region", { name: "Simulation receipts" });
  const details = region.locator("details");
  if (!(await details.evaluate((element) => element.hasAttribute("open")))) {
    // A job/artifact detail drawer can cover the shell ledger. Expand the
    // durable ledger directly, then assert its rendered contents.
    await details.evaluate((element) => element.setAttribute("open", ""));
  }
  return details.getByRole("listitem").first();
}

function acceptNextConfirmation(page: Page): void {
  page.once("dialog", async (dialog) => dialog.accept());
}

test.beforeEach(async ({ page }) => {
  await page.goto(STATIC_HOST);
});

test("consent grant precedes IndexedDB, health, telemetry, and populated demo entry", async ({
  page,
  context,
}) => {
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  await context.route("**/api/demo-consent", async (route) => {
    const request = route.request();
    requests.push({
      path: "/api/demo-consent",
      method: request.method(),
      body: request.postData() ? (request.postDataJSON() as unknown) : null,
    });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        choice: request.method() === "POST" ? "granted" : "unknown",
        version: "v1",
      }),
    });
  });
  for (const path of ["/api/demo-health", "/api/demo-telemetry"] as const) {
    await context.route(`**${path}`, async (route) => {
      requests.push({
        path,
        method: route.request().method(),
        body: route.request().postDataJSON() as unknown,
      });
      await route.fulfill({ status: 204, body: "" });
    });
  }

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Explore JobCtrl/i })).toBeVisible();
  await expect(page.getByText(/demo can only be used after accepting.*analytics cookies/i)).toBeVisible();
  expect(requests.map(({ path }) => path)).toEqual(["/api/demo-consent"]);
  expect(await page.evaluate(async () =>
    (await indexedDB.databases()).some((database) => database.name === "jobctrl-demo"),
  )).toBe(false);

  await page.getByRole("button", { name: "Accept cookies and enter demo" }).click();
  await expect(page.getByText("Demo mode — shared browser profile")).toBeVisible();
  await expect.poll(async () => page.evaluate(async () =>
    (await indexedDB.databases()).some((database) => database.name === "jobctrl-demo"),
  )).toBe(true);
  await expect.poll(() => requests.some(({ path }) => path === "/api/demo-health")).toBe(true);
  await expect.poll(() => requests.some(({ path }) => path === "/api/demo-telemetry")).toBe(true);

  const grantIndex = requests.findIndex(({ path, method }) =>
    path === "/api/demo-consent" && method === "POST");
  const healthIndex = requests.findIndex(({ path }) => path === "/api/demo-health");
  const telemetryIndex = requests.findIndex(({ path }) => path === "/api/demo-telemetry");
  expect(grantIndex).toBeGreaterThan(0);
  expect(healthIndex).toBeGreaterThan(grantIndex);
  expect(telemetryIndex).toBeGreaterThan(grantIndex);
  expect(requests[grantIndex]?.body).toMatchObject({ choice: "granted" });
});

test("decline stays anonymous and redirects even when consent measurement fails", async ({
  page,
  context,
}) => {
  const requests: Array<{ path: string; body: unknown }> = [];
  await context.route("**/api/demo-consent", async (route) => {
    const request = route.request();
    requests.push({
      path: "/api/demo-consent",
      body: request.postData() ? (request.postDataJSON() as unknown) : null,
    });
    if (request.method() === "POST") {
      await route.abort("failed");
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ choice: "unknown", version: "v1" }),
    });
  });
  await context.route("https://jobctrl.dev/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>JobCtrl</h1>" }),
  );
  await context.route("**/api/demo-health", (route) => route.abort("blockedbyclient"));
  await context.route("**/api/demo-telemetry", (route) => route.abort("blockedbyclient"));

  await page.goto("/");
  await page.getByRole("button", { name: "Decline and return to jobctrl.dev" }).click();
  await expect(page).toHaveURL("https://jobctrl.dev/");
  expect(requests).toHaveLength(2);
  expect(requests[1]?.body).toEqual({
    choice: "denied",
    operationKey: expect.stringMatching(/^[A-Za-z0-9_-]{32,128}$/),
  });
  expect(await page.evaluate(async () =>
    (await indexedDB.databases()).some((database) => database.name === "jobctrl-demo"),
  )).toBe(false);
});

test("a denied revisit reopens the acceptance-required gate", async ({ page, context }) => {
  const optionalRequests: string[] = [];
  await context.route("**/api/demo-consent", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ choice: "denied", version: "v1" }),
    }),
  );
  for (const path of ["/api/demo-health", "/api/demo-telemetry"] as const) {
    await context.route(`**${path}`, (route) => {
      optionalRequests.push(path);
      return route.abort("blockedbyclient");
    });
  }

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Explore JobCtrl/i })).toBeVisible();
  await expect(page.getByText(/previously declined/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept cookies and enter demo" })).toBeVisible();
  expect(optionalRequests).toEqual([]);
  expect(await page.evaluate(async () =>
    (await indexedDB.databases()).some((database) => database.name === "jobctrl-demo"),
  )).toBe(false);
});

test("a stalled consent read still renders the static gate without creating a workspace", async ({
  page,
  context,
}) => {
  let releaseRequest: (() => void) | undefined;
  const stalled = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  await context.route("**/api/demo-consent", async (route) => {
    await stalled;
    await route.abort("failed");
  });

  try {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Explore JobCtrl/i })).toBeVisible({
      timeout: 1_000,
    });
    await expect(
      page.getByRole("button", { name: "Accept cookies and enter demo" }),
    ).toBeEnabled();
    expect(await page.evaluate(async () =>
      (await indexedDB.databases()).some((database) => database.name === "jobctrl-demo"),
    )).toBe(false);
  } finally {
    releaseRequest?.();
  }
});

test("a fresh grant wins over a stale denied consent read", async ({ page, context }) => {
  let releaseRead: (() => void) | undefined;
  let confirmReadResponse: (() => void) | undefined;
  const stalledRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const readResponseSent = new Promise<void>((resolve) => {
    confirmReadResponse = resolve;
  });
  await context.route("**/api/demo-consent", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ choice: "granted", version: "v1" }),
      });
      return;
    }
    await stalledRead;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ choice: "denied", version: "v1" }),
    });
    confirmReadResponse?.();
  });
  await context.route("**/api/demo-health", (route) => route.fulfill({ status: 204 }));
  await context.route("**/api/demo-telemetry", (route) => route.fulfill({ status: 204 }));

  await page.goto("/");
  await page.getByRole("button", { name: "Accept cookies and enter demo" }).click();
  await expect(page.getByText("Demo mode — shared browser profile")).toBeVisible();
  releaseRead?.();
  await readResponseSent;
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  ));
  await expect(page.getByText("Demo mode — shared browser profile")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Explore JobCtrl/i })).toHaveCount(0);
});

scenarioTest(
  "J1 run-current-stage shows durable queued, running, and terminal state across tabs",
  async ({ page, context }) => {
    const second = await context.newPage();
    await Promise.all([
      page.goto("/jobs/job-fabrikam-systems"),
      second.goto("/jobs"),
    ]);
    await expect(
      page.getByRole("dialog", { name: "Job details" }),
    ).toBeVisible();
    await expectJobState(second, "Systems delivery director", "succeeded");

    acceptNextConfirmation(page);
    await page
      .getByRole("button", { name: "run current stage", exact: true })
      .click();

    await expectJobState(second, "Systems delivery director", "queued", 1_000);
    await expectJobState(second, "Systems delivery director", "running");
    await expect(
      page
        .getByRole("dialog", { name: "Job details" })
        .getByText("running", { exact: true }),
    ).toBeVisible();
    await expectJobState(second, "Systems delivery director", "succeeded");
    await expect(
      page
        .getByRole("dialog", { name: "Job details" })
        .getByText("succeeded", { exact: true }),
    ).toBeVisible();

    await second.reload();
    await expectJobState(second, "Systems delivery director", "succeeded");
  },
);

scenarioTest(
  "J2 Contoso re-tailoring fails first, preserves accepted material, and retries successfully",
  async ({ page }) => {
    await page.goto("/jobs/job-contoso-reliability");
    const drawer = page.getByRole("dialog", { name: "Job details" });
    await expect(
      drawer.getByRole("heading", { name: "Reliability engineering manager" }),
    ).toBeVisible();
    await expect(drawer.getByText("accepted", { exact: true })).toHaveCount(2);

    acceptNextConfirmation(page);
    await drawer
      .getByRole("button", { name: "re-tailor current policy", exact: true })
      .click();
    await expect(drawer.getByText("failed", { exact: true })).toBeVisible({
      timeout: 3_000,
    });
    await expect(drawer.getByText("accepted", { exact: true })).toHaveCount(2);
    await expect(drawer.getByText("suppressed", { exact: true })).toHaveCount(
      0,
    );

    await drawer.getByRole("button", { name: "retry", exact: true }).click();
    await expect(drawer.getByText("succeeded", { exact: true })).toBeVisible({
      timeout: 3_000,
    });
    await expect(drawer.getByText("accepted", { exact: true })).toHaveCount(2);
    await expect(drawer.getByText("suppressed", { exact: true })).toHaveCount(
      2,
    );

    await page.reload();
    const reloadedDrawer = page.getByRole("dialog", { name: "Job details" });
    await expect(
      reloadedDrawer.getByText("succeeded", { exact: true }),
    ).toBeVisible();
    await expect(
      reloadedDrawer.getByText("accepted", { exact: true }),
    ).toHaveCount(2);
    await expect(
      reloadedDrawer.getByText("suppressed", { exact: true }),
    ).toHaveCount(2);
  },
);

scenarioTest(
  "application rehearsals append durable no-effect receipts",
  async ({ page, context }) => {
    const second = await context.newPage();
    await Promise.all([
      page.goto("/jobs/job-fabrikam-systems"),
      second.goto("/jobs/job-fabrikam-systems"),
    ]);
    const drawer = page.getByRole("dialog", { name: "Job details" });
    const initialCount = await receiptCount(page);
    await expectReceiptCount(second, initialCount);

    await drawer
      .getByRole("button", { name: "rehearse application", exact: true })
      .click();
    await expectReceiptCount(page, initialCount + 1);
    const applyReceipt = await latestReceipt(page);
    await expect(applyReceipt).toContainText("Apply job");
    await expect(applyReceipt).toContainText(
      /no browser automation.*application destination.*accessed/i,
    );

    await drawer
      .getByRole("button", { name: "record simulated applied", exact: true })
      .click();
    await expectReceiptCount(page, initialCount + 2);
    const markAppliedReceipt = await latestReceipt(page);
    await expect(markAppliedReceipt).toContainText("Mark applied");
    await expect(markAppliedReceipt).toContainText(
      /no application was submitted/i,
    );
    await expectReceiptCount(second, initialCount + 2);

    await second.reload();
    await expectReceiptCount(second, initialCount + 2);
    await expect(await latestReceipt(second)).toContainText("Mark applied");
  },
);

scenarioTest(
  "artifact rehearsal opens only the validated same-origin preview and records no host-OS effect",
  async ({ page, context }) => {
    await page.goto("/artifacts/artifact-tailored-resume");
    const drawer = page.getByRole("dialog", { name: "Artifact details" });
    await expect(
      page.getByRole("region", { name: "Artifact PDF preview" }),
    ).toBeVisible();
    const initialCount = await receiptCount(page);
    await page.evaluate(() => {
      const originalOpen = window.open.bind(window);
      window.__jobctrlDemoOpenedUrls = [];
      window.open = (url, target, features) => {
        window.__jobctrlDemoOpenedUrls?.push(String(url));
        return originalOpen(url, target, features);
      };
    });

    const popupPromise = context.waitForEvent("page");
    await drawer
      .getByRole("button", { name: "preview in browser", exact: true })
      .click();
    const popup = await popupPromise;
    await expect
      .poll(() => page.evaluate(() => window.__jobctrlDemoOpenedUrls))
      .toEqual(["/demo/tailored-resume.pdf"]);

    await expectReceiptCount(page, initialCount + 1);
    const receipt = await latestReceipt(page);
    await expect(receipt).toContainText("Open artifact");
    await expect(receipt).toContainText(/same-origin.*preview.*opened/i);
    await expect(receipt).toContainText(
      /no .*host.*(?:os|operating system|local path)/i,
    );
    await popup.close();
  },
);

scenarioTest("demo shell renders the shared-profile and personal-data boundary without product network", async ({
  page,
  context,
}) => {
  const productRequests: string[] = [];
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/v1/")) {
      productRequests.push(url.pathname);
    }
  });

  await page.goto("/");
  const notice = page.getByRole("status", {
    name: "Public demo data boundary",
  });
  await expect(notice).toContainText(
    "shared with other tabs and people using this browser profile",
  );
  await expect(notice).toContainText("Do not enter personal data or secrets");
  await expect(
    page.getByText("Demo mode — shared browser profile"),
  ).toBeVisible();
  expect(productRequests).toEqual([]);
});

scenarioTest("Demo guide shortcuts navigate through seeded surfaces and confirm reset", async ({ page }) => {
  await page.goto("/dashboard");
  const guide = page.getByRole("complementary", {
    name: "Try the synthetic workflow",
  });
  await expect(guide).toContainText("Every record and action in this demo is simulated and synthetic");

  await guide.getByRole("link", { name: "Inspect synthetic scoring evidence" }).click();
  await expect(page).toHaveURL(/\/jobs\/job-northwind-platform(?:\?|$)/);
  await expect(page.getByText("Preparation diagnostics", { exact: false })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Job details" })).toBeHidden();

  await guide.getByRole("link", { name: "Review synthetic tailored materials" }).click();
  await expect(page).toHaveURL(/\/artifacts\/artifact-tailored-resume(?:\?|$)/);
  await expect(page.getByRole("dialog", { name: "Artifact details" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Artifact details" })).toBeHidden();

  await guide.getByRole("link", { name: "Open simulated Apply Review and dry run" }).click();
  await expect(page).toHaveURL(/\/apply-review\?jobKey=job-northwind-platform(?:&|$)/);
  await expect(page.getByRole("heading", { name: "Application review" })).toBeVisible();

  await guide.getByRole("link", { name: "See simulated run history" }).click();
  await expect(page).toHaveURL(/\/runs(?:\?|$)/);
  await expect(page.getByRole("heading", { name: "Workflow runs" })).toBeVisible();

  const before = await resetEpoch(page);
  await guide.getByRole("button", { name: "Reset synthetic demo data" }).click();
  await expect(page.getByRole("dialog", { name: "Reset synthetic demo data?" })).toBeVisible();
  await page.getByRole("button", { name: "Reset demo data" }).click();
  await expect(guide.getByRole("status")).toContainText(
    "Synthetic demo data reset. The seeded examples are ready again.",
  );
  await expect.poll(() => resetEpoch(page)).toBe(before + 1);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(guide).toBeVisible();
  const guideBounds = await guide.boundingBox();
  expect(guideBounds).not.toBeNull();
  expect(guideBounds!.x).toBeGreaterThanOrEqual(0);
  expect(guideBounds!.x + guideBounds!.width).toBeLessThanOrEqual(390);
  expect(guideBounds!.y + guideBounds!.height).toBeLessThanOrEqual(844);
});

scenarioTest("every P2 product route and seeded deep link renders populated across direct refreshes", async ({
  page,
  context,
}) => {
  const productRequests: string[] = [];
  const externalRequests: string[] = [];
  const runtimeErrors: string[] = [];
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/v1/")) {
      productRequests.push(url.pathname);
    }
    if (url.origin !== "http://127.0.0.1:5198") {
      externalRequests.push(request.url());
    }
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));

  const routes = [
    ["/dashboard", "Dashboard", "3 jobs"],
    ["/jobs", "Jobs", "Platform systems lead"],
    ["/jobs/job-northwind-platform", "Jobs", "Preparation diagnostics"],
    ["/evidence-map", "Career evidence map", "Delivery improvement evidence"],
    ["/artifacts", "Artifacts", "Platform systems lead"],
    ["/artifacts/artifact-tailored-resume", "Artifacts", "Artifact details"],
    [
      "/apply-review?jobKey=job-northwind-platform",
      "Application review",
      "Materials ready",
    ],
    ["/runs", "Workflow runs", "Platform systems lead"],
    ["/runs/run-materials-progress", "Workflow runs", "Run details"],
    ["/analytics", "Outcome analytics", "bundled-capture"],
    ["/profile", "Profile", "Baseline resume editor"],
    ["/settings", "Settings", "Config"],
    ["/settings/credentials", "Settings", "OpenAI API Key"],
    ["/outreach", "Contacts", "Synthetic hiring partner"],
    [
      "/outreach/contact-demo-hiring-partner",
      "Contacts",
      "Facts and provenance",
    ],
    ["/discovery", "Discovery", "Bundled synthetic source"],
    ["/pipelines", "Pipelines", "Configuring"],
    ["/debug", "Debug", "Synthetic score recorded."],
    [
      "/activity/event-demo-score",
      "Activity details",
      "Event details",
      "dialog",
    ],
  ] as const;

  for (const [route, identity, populatedText, role = "heading"] of routes) {
    await page.goto(STATIC_HOST);
    await page.goto(route);
    const identityLocator =
      role === "dialog"
        ? page.getByRole("dialog", { name: identity })
        : page.getByRole("heading", { name: identity }).first();
    await expect(identityLocator).toBeVisible();
    await expect(
      page.getByText(populatedText, { exact: false }).first(),
    ).toBeVisible();
    expect(page.url()).toContain(route);

    await page.reload();
    await expect(
      role === "dialog"
        ? page.getByRole("dialog", { name: identity })
        : page.getByRole("heading", { name: identity }).first(),
    ).toBeVisible();
    await expect(
      page.getByText(populatedText, { exact: false }).first(),
    ).toBeVisible();
  }

  expect(runtimeErrors).toEqual([]);
  expect(productRequests).toEqual([]);
  expect(externalRequests).toEqual([]);
});

scenarioTest("same-context tabs share, serialize concurrent writes, and survive reload without product network", async ({
  page,
  context,
}) => {
  const productRequests: string[] = [];
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname.startsWith("/v1/") ||
      url.pathname === "/v1/events/stream"
    ) {
      productRequests.push(url.pathname);
    }
  });
  const second = await context.newPage();
  await second.goto(STATIC_HOST);
  const [firstInit, secondInit] = await Promise.all([
    initializeWorkspace(page),
    initializeWorkspace(second),
  ]);
  expect(firstInit).toMatchObject({ kind: "ready", storageMode: "indexeddb" });
  expect(secondInit).toMatchObject({ kind: "ready", storageMode: "indexeddb" });
  if (firstInit.kind !== "ready" || secondInit.kind !== "ready") return;
  expect(firstInit.snapshot.workspaceId).toBe(secondInit.snapshot.workspaceId);

  await Promise.all([
    page.evaluate(async () => {
      if (!window.__jobctrlDemoWorkspace)
        throw new Error("workspace not initialized");
      await window.__jobctrlDemoWorkspace.queueScenario({
        scenarioId: "tab-one",
        deadlineAt: "2026-07-11T12:01:00.000Z",
        resetEpoch: 0,
      });
    }),
    second.evaluate(async () => {
      if (!window.__jobctrlDemoWorkspace)
        throw new Error("workspace not initialized");
      await window.__jobctrlDemoWorkspace.queueScenario({
        scenarioId: "tab-two",
        deadlineAt: "2026-07-11T12:02:00.000Z",
        resetEpoch: 0,
      });
    }),
  ]);
  const shared = await snapshot(page);
  expect(shared.revision).toBe(2);
  expect(
    shared.pendingScenarios.map((scenario) => scenario.scenarioId).toSorted(),
  ).toEqual(["tab-one", "tab-two"]);

  await page.reload();
  const reloaded = await initializeWorkspace(page);
  expect(reloaded).toMatchObject({
    kind: "ready",
    snapshot: {
      workspaceId: shared.workspaceId,
      revision: 2,
    },
  });
  expect(productRequests).toEqual([]);
});

scenarioTest("eventless discovery and settings writes resync across tabs and survive reload", async ({
  page,
  context,
}) => {
  const productRequests: string[] = [];
  const externalRequests: string[] = [];
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/v1/")) productRequests.push(url.pathname);
    if (url.origin !== "http://127.0.0.1:5198") externalRequests.push(request.url());
  });
  const second = await context.newPage();

  await Promise.all([page.goto("/discovery"), second.goto("/discovery")]);
  await expect(page.getByLabel("Results per board")).toHaveValue("12");
  await expect(second.getByLabel("Results per board")).toHaveValue("12");
  await page.getByLabel("Results per board").fill("23");
  await page.getByRole("button", { name: "save runtime settings" }).click();
  await expect(page.getByText("runtime settings saved")).toBeVisible();
  await expect(second.getByLabel("Results per board")).toHaveValue("23");
  await second.reload();
  await expect(second.getByLabel("Results per board")).toHaveValue("23");

  await Promise.all([page.goto("/settings"), second.goto("/settings")]);
  await expect(page.getByLabel("Apply concurrency")).toHaveValue("1");
  await expect(second.getByLabel("Apply concurrency")).toHaveValue("1");
  await page.getByLabel("Apply concurrency").fill("3");
  const executionForm = page.locator("form").filter({ has: page.getByLabel("Apply concurrency") });
  await executionForm.getByRole("button", { name: "save", exact: true }).click();
  await expect(page.getByText("settings saved", { exact: true })).toBeVisible();
  await expect(second.getByLabel("Apply concurrency")).toHaveValue("3");
  await second.reload();
  await expect(second.getByLabel("Apply concurrency")).toHaveValue("3");

  expect(productRequests).toEqual([]);
  expect(externalRequests).toEqual([]);
});

scenarioTest("discovery promotes a source and imports a manual capture through the real browser-local UI", async ({
  page,
  context,
}) => {
  const productRequests: string[] = [];
  const externalRequests: string[] = [];
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/v1/")) productRequests.push(url.pathname);
    if (url.origin !== "http://127.0.0.1:5198") externalRequests.push(request.url());
  });

  await page.goto("/discovery");
  await page.getByRole("tab", { name: "Source locator" }).click();
  const promote = page.getByRole("button", {
    name: "Promote /demo/source-preview.html",
  });
  await expect(promote).toBeVisible();
  await promote.click();
  await expect(page.getByText("No source candidates.")).toBeVisible();

  await page.getByRole("tab", { name: "Manual capture" }).click();
  const importCapture = page.getByRole("button", {
    name: "Import https://demo.invalid/source-preview.html",
  });
  await expect(importCapture).toBeEnabled();
  await importCapture.click();
  await expect(page.getByText("No manual captures.")).toBeVisible();

  await page.goto("/jobs");
  await expect(page.getByText("Bundled manual-capture opportunity", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Bundled manual-capture opportunity", { exact: true })).toBeVisible();
  expect(productRequests).toEqual([]);
  expect(externalRequests).toEqual([]);
});

scenarioTest("score correction is browser-local, cross-tab visible, reload durable, and network-free", async ({
  page,
  context,
}) => {
  const productRequests: string[] = [];
  const externalRequests: string[] = [];
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/v1/")) productRequests.push(url.pathname);
    if (url.origin !== "http://127.0.0.1:5198") externalRequests.push(request.url());
  });

  const second = await context.newPage();
  await Promise.all([
    page.goto("/jobs/job-northwind-platform"),
    second.goto("/jobs/job-northwind-platform"),
  ]);
  await expect(page.getByText("8/10", { exact: true })).toBeVisible();
  await expect(second.getByText("8/10", { exact: true })).toBeVisible();

  await page.getByLabel("Correct score").fill("9");
  await page.getByLabel("Reason").fill("Reviewed bundled synthetic evidence");
  await page.getByRole("button", { name: "Save score correction" }).click();
  await expect(page.getByText("Scoring policy updated;", { exact: false })).toBeVisible();
  await expect(page.getByText("9/10", { exact: true })).toBeVisible();
  await expect(second.getByText("9/10", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByText("9/10", { exact: true })).toBeVisible();
  expect(productRequests).toEqual([]);
  expect(externalRequests).toEqual([]);
});

scenarioTest("separate browser contexts isolate workspaces", async ({
  page,
  browser,
}) => {
  const first = await initializeWorkspace(page);
  const isolatedContext = await browser.newContext();
  try {
    const isolatedPage = await isolatedContext.newPage();
    await isolatedPage.goto(STATIC_HOST);
    const isolated = await initializeWorkspace(isolatedPage);
    expect(first.kind).toBe("ready");
    expect(isolated.kind).toBe("ready");
    if (first.kind !== "ready" || isolated.kind !== "ready") return;
    expect(first.snapshot.workspaceId).not.toBe(isolated.snapshot.workspaceId);
  } finally {
    await isolatedContext.close();
  }
});

scenarioTest("reset rotates identity, fences state, and deletes generated blobs", async ({
  page,
}) => {
  const initialized = await initializeWorkspace(page);
  expect(initialized.kind).toBe("ready");
  if (initialized.kind !== "ready") return;
  await page.evaluate(async () => {
    if (!window.__jobctrlDemoWorkspace)
      throw new Error("workspace not initialized");
    await window.__jobctrlDemoWorkspace.putBlob(
      "generated-preview",
      new Blob(["synthetic visitor edit"], { type: "text/plain" }),
    );
    await window.__jobctrlDemoWorkspace.queueScenario({
      scenarioId: "reset-me",
      deadlineAt: "2026-07-11T12:03:00.000Z",
      resetEpoch: 0,
    });
    await window.__jobctrlDemoWorkspace.reset();
  });
  const reset = await snapshot(page);
  expect(reset.workspaceId).not.toBe(initialized.snapshot.workspaceId);
  expect(reset).toMatchObject({
    resetEpoch: 1,
    resetCount: 1,
    pendingScenarios: [],
  });
  expect(
    await page.evaluate(async () => {
      if (!window.__jobctrlDemoWorkspace)
        throw new Error("workspace not initialized");
      return (
        (await window.__jobctrlDemoWorkspace.blob("generated-preview")) === null
      );
    }),
  ).toBe(true);
});

scenarioTest("future native database version is upgrade-required without downgrade", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const request = indexedDB.open("jobctrl-demo", 2);
    await new Promise<void>((resolve, reject) => {
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("workspace")) {
          request.result.createObjectStore("workspace", { keyPath: "key" });
        }
        if (!request.result.objectStoreNames.contains("blobs")) {
          request.result.createObjectStore("blobs");
        }
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  });

  const result = await initializeWorkspace(page);
  expect(result).toMatchObject({
    kind: "upgrade_required",
    scope: "database_version",
    foundDatabaseVersion: 2,
    supportedDatabaseVersion: 1,
  });
  expect(
    await page.evaluate(
      async () =>
        (await indexedDB.databases()).find(
          (database) => database.name === "jobctrl-demo",
        )?.version,
    ),
  ).toBe(2);
});

scenarioTest("postcommit event adapter emits only valid ordered domain events", async ({
  page,
}) => {
  const result = await page.evaluate(async (moduleUrls) => {
    const [repositoryModule, storageModule, eventStreamModule] =
      await Promise.all([
        import(moduleUrls.repository),
        import(moduleUrls.storage),
        import(moduleUrls.eventStream),
      ]);
    const workspace = new repositoryModule.DemoWorkspaceRepository({
      store: new storageModule.IndexedDbDemoWorkspaceStore(),
    });
    await workspace.initialize();
    const adapter = new eventStreamModule.DemoWorkspaceEventStreamAdapter(
      workspace,
    );
    const subscription = adapter.subscribe({ tenantId: "local" });
    const events: string[] = [];
    let resolveEvent!: () => void;
    const eventDelivered = new Promise<void>((resolve) => {
      resolveEvent = resolve;
    });
    subscription.on((event: { eventType: string }) => {
      events.push(event.eventType);
      resolveEvent();
    });
    await workspace.mutate(
      (
        _draft: unknown,
        context: { appendDomainEvent(event: unknown): void },
      ) => {
        context.appendDomainEvent({
          eventType: "JobUpdated",
          tenantId: "local",
          occurredAt: "2026-07-11T12:00:00.000Z",
          payload: { jobId: "job-demo", changedFields: { title: "Updated" } },
        });
      },
    );
    await eventDelivered;
    subscription.close();
    return events;
  }, MODULE_URLS);
  expect(result).toEqual(["JobUpdated"]);
});
