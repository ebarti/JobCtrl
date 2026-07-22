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
const CURRENT_DEMO_SEED_VERSION = "2026-07-12.2";
const GOOGLE_TAG_ORIGIN = "https://www.googletagmanager.com";
const GOOGLE_TAG_MEASUREMENT_ID = "G-6MJGD17JN0";

function configuredOrigin(baseURL: string | undefined): string {
  if (!baseURL) throw new Error("Demo Playwright baseURL is required.");
  return new URL(baseURL).origin;
}

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
            body: JSON.stringify({ choice: "granted", version: "v2" }),
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
        if (
          requestUrl.origin === GOOGLE_TAG_ORIGIN &&
          requestUrl.pathname === "/gtag/js" &&
          requestUrl.searchParams.get("id") === GOOGLE_TAG_MEASUREMENT_ID
        ) {
          await route.fulfill({ contentType: "application/javascript", body: "" });
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

function visible(page: Page, locator: Locator): Locator {
  return locator.and(page.locator(":visible"));
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
  const details = region.locator(".demo-receipt-history__disclosure");
  if (!(await details.evaluate((element) => element.hasAttribute("open")))) {
    // A long detail workspace can put the shell ledger outside the viewport.
    // Expand the durable ledger directly, then assert its rendered contents.
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

scenarioTest("pipeline demo capability actions stay contained at 320 CSS pixels", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/pipelines");

  const alert = page
    .getByRole("alert")
    .filter({ hasText: "Live pipeline controls require the local app" });
  const title = alert.getByText("Live pipeline controls require the local app");
  const description = alert.locator('[data-slot="alert-description"]');
  const actions = alert.locator('[data-slot="alert-action"]');
  const actionLinks = actions.getByRole("link");

  await expect(alert).toBeVisible();
  await expect(title).toBeVisible();
  await expect(description).toBeVisible();
  await expect(actions).toBeVisible();
  await expect(actionLinks).toHaveCount(2);

  const layout = await alert.evaluate((element) => {
    const rect = (target: Element) => {
      const box = target.getBoundingClientRect();
      return {
        bottom: box.bottom,
        left: box.left,
        right: box.right,
        top: box.top,
      };
    };
    const title = element.querySelector('[data-slot="alert-title"]');
    const description = element.querySelector('[data-slot="alert-description"]');
    const actions = element.querySelector('[data-slot="alert-action"]');
    if (!title || !description || !actions) {
      throw new Error("Expected pipeline capability alert structure.");
    }
    const alert = rect(element);
    return {
      actions: [...actions.querySelectorAll("a")].map(rect),
      container: rect(actions),
      description: rect(description),
      scrollWidth: document.documentElement.scrollWidth,
      title: rect(title),
      viewportWidth: document.documentElement.clientWidth,
      alert,
    };
  });
  const contained = (box: typeof layout.title) =>
    box.left >= layout.alert.left - 1 &&
    box.right <= layout.alert.right + 1 &&
    box.top >= layout.alert.top - 1 &&
    box.bottom <= layout.alert.bottom + 1;

  expect(contained(layout.title), "capability alert title should be contained").toBe(true);
  expect(
    contained(layout.description),
    "capability alert description should be contained",
  ).toBe(true);
  expect(
    contained(layout.container),
    "capability action group should be contained",
  ).toBe(true);
  expect(
    layout.actions.every(contained),
    "each capability action should be contained",
  ).toBe(true);
  expect(
    layout.description.top,
    "capability alert description should follow the title",
  ).toBeGreaterThanOrEqual(layout.title.bottom - 1);
  expect(
    layout.container.top,
    "capability actions should follow the description in normal flow",
  ).toBeGreaterThanOrEqual(layout.description.bottom - 1);
  expect(
    layout.actions[0]!.right <= layout.actions[1]!.left + 1 ||
      layout.actions[0]!.bottom <= layout.actions[1]!.top + 1 ||
      layout.actions[1]!.right <= layout.actions[0]!.left + 1 ||
      layout.actions[1]!.bottom <= layout.actions[0]!.top + 1,
    "capability actions should not overlap",
  ).toBe(true);
  expect(
    layout.scrollWidth,
    "pipeline capability alert should not create horizontal overflow",
  ).toBeLessThanOrEqual(layout.viewportWidth + 1);
});

test("consent grant precedes Google Analytics, IndexedDB, health, telemetry, and populated demo entry", async ({
  page,
  context,
}) => {
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  const googleTagRequests: string[] = [];
  await context.route("**/gtag/js**", async (route) => {
    googleTagRequests.push(route.request().url());
    await route.fulfill({ contentType: "application/javascript", body: "" });
  });
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
        version: "v2",
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
  expect(googleTagRequests).toEqual([]);
  expect(await page.evaluate(async () =>
    (await indexedDB.databases()).some((database) => database.name === "jobctrl-demo"),
  )).toBe(false);

  await page.getByRole("button", { name: "Accept cookies and enter demo" }).click();
  await expect(page.getByText("Demo mode — browser-local workspace")).toBeVisible();
  await expect.poll(async () => page.evaluate(async () =>
    (await indexedDB.databases()).some((database) => database.name === "jobctrl-demo"),
  )).toBe(true);
  await expect.poll(() => requests.some(({ path }) => path === "/api/demo-health")).toBe(true);
  await expect.poll(() => requests.some(({ path }) => path === "/api/demo-telemetry")).toBe(true);
  await expect.poll(() => googleTagRequests).toHaveLength(1);
  expect(new URL(googleTagRequests[0]!).searchParams.get("id")).toBe(GOOGLE_TAG_MEASUREMENT_ID);

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
  const googleTagRequests: string[] = [];
  await context.route("**/gtag/js**", (route) => {
    googleTagRequests.push(route.request().url());
    return route.abort("blockedbyclient");
  });
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
      body: JSON.stringify({ choice: "unknown", version: "v2" }),
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
  expect(googleTagRequests).toEqual([]);
  expect(await page.evaluate(async () =>
    (await indexedDB.databases()).some((database) => database.name === "jobctrl-demo"),
  )).toBe(false);
});

test("a denied revisit reopens the acceptance-required gate", async ({ page, context }) => {
  const optionalRequests: string[] = [];
  await context.route("**/api/demo-consent", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ choice: "denied", version: "v2" }),
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
        body: JSON.stringify({ choice: "granted", version: "v2" }),
      });
      return;
    }
    await stalledRead;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ choice: "denied", version: "v2" }),
    });
    confirmReadResponse?.();
  });
  await context.route("**/api/demo-health", (route) => route.fulfill({ status: 204 }));
  await context.route("**/api/demo-telemetry", (route) => route.fulfill({ status: 204 }));

  await page.goto("/");
  await page.getByRole("button", { name: "Accept cookies and enter demo" }).click();
  await expect(page.getByText("Demo mode — browser-local workspace")).toBeVisible();
  releaseRead?.();
  await readResponseSent;
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  ));
  await expect(page.getByText("Demo mode — browser-local workspace")).toBeVisible();
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
      page.getByRole("article", { name: "Job details" }),
    ).toBeVisible();
    await expectJobState(second, "Systems delivery director", "failed");

    acceptNextConfirmation(page);
    await page
      .getByRole("button", { name: "Run current stage", exact: true })
      .click();

    await expectJobState(second, "Systems delivery director", "queued", 1_000);
    await expectJobState(second, "Systems delivery director", "running");
    await expect(
      page
        .getByRole("article", { name: "Job details" })
        .getByText("running", { exact: true }),
    ).toBeVisible();
    await expectJobState(second, "Systems delivery director", "succeeded");
    await expect(
      page
        .getByRole("article", { name: "Job details" })
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
    const drawer = page.getByRole("article", { name: "Job details" });
    await expect(
      drawer.getByRole("heading", { name: "Reliability engineering manager" }),
    ).toBeVisible();
    await expect(drawer.getByText("accepted", { exact: true })).toHaveCount(2);

    acceptNextConfirmation(page);
    await drawer
      .getByRole("button", { name: "Re-tailor current policy", exact: true })
      .click();
    await expect(drawer.getByText("failed", { exact: true })).toBeVisible({
      timeout: 3_000,
    });
    await expect(drawer.getByText("accepted", { exact: true })).toHaveCount(2);
    await expect(drawer.getByText("suppressed", { exact: true })).toHaveCount(
      0,
    );

    await drawer.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(drawer.getByText("succeeded", { exact: true })).toBeVisible({
      timeout: 3_000,
    });
    await expect(drawer.getByText("accepted", { exact: true })).toHaveCount(2);
    await expect(drawer.getByText("suppressed", { exact: true })).toHaveCount(
      2,
    );

    await page.reload();
    const reloadedDrawer = page.getByRole("article", { name: "Job details" });
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
  "blocked Contoso Apply Review handoff preserves the requested job identity",
  async ({ page }) => {
    const runtimeErrors: string[] = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));

    await page.goto("/jobs/job-contoso-reliability");
    const drawer = page.getByRole("article", { name: "Job details" });
    await drawer
      .getByRole("link", {
        name: "Open Apply Review for Reliability engineering manager",
      })
      .click();

    await expect(page).toHaveURL(
      /\/apply-review\?jobKey=job-contoso-reliability(?:&|$)/,
    );
    await expect(
      page.getByText("This job is not in the application review queue."),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Application review" }),
    ).toBeVisible();
    await expect(page.getByText("Something went wrong!", { exact: true })).toHaveCount(0);
    expect(runtimeErrors).toEqual([]);
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
    const drawer = page.getByRole("article", { name: "Job details" });
    const initialCount = await receiptCount(page);
    await expectReceiptCount(second, initialCount);

    await drawer
      .getByRole("button", { name: "Rehearse application", exact: true })
      .click();
    await expectReceiptCount(page, initialCount + 1);
    const applyReceipt = await latestReceipt(page);
    await expect(applyReceipt).toContainText("Apply job");
    await expect(applyReceipt).toContainText(
      /no browser automation.*application destination.*accessed/i,
    );

    await drawer
      .getByRole("button", { name: "Record simulated application", exact: true })
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
    const drawer = page.getByRole("article", { name: "Artifact details" });
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
      .getByRole("button", { name: "Preview in browser", exact: true })
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

scenarioTest("demo shell renders the browser-profile isolation and personal-data boundary without product network", async ({
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
  await expect(notice).toContainText("not shared across browser profiles");
  await expect(notice).toContainText("common demo environment");
  await expect(notice).toContainText(
    "Other tabs and anyone using this profile can see the same data",
  );
  await expect(notice).toContainText("Do not enter personal data or secrets");
  await expect(
    page.getByText("Demo mode — browser-local workspace"),
  ).toBeVisible();
  expect(productRequests).toEqual([]);
});

scenarioTest("Demo guide shortcuts navigate through seeded surfaces and confirm reset", async ({ page }) => {
  await page.goto("/dashboard");
  const guide = page.getByRole("complementary", {
    name: "Try the synthetic workflow",
  });
  const openGuide = page.getByRole("button", { name: "Open demo guide" });
  await openGuide.click();
  await expect(guide).toContainText("Every record and action in this demo is simulated and synthetic");

  await guide.getByRole("link", { name: "Inspect synthetic scoring evidence" }).click();
  await expect(page).toHaveURL(/\/jobs\/job-northwind-platform(?:\?|$)/);
  await expect(page.getByText("Preparation diagnostics", { exact: false })).toBeVisible();
  await expect(page.getByRole("article", { name: "Job details" })).toBeVisible();

  await openGuide.click();
  await guide.getByRole("link", { name: "Review synthetic tailored materials" }).click();
  await expect(page).toHaveURL(/\/artifacts\/artifact-tailored-resume(?:\?|$)/);
  await expect(page.getByRole("article", { name: "Artifact details" })).toBeVisible();

  await openGuide.click();
  await guide.getByRole("link", { name: "Open simulated Apply Review and dry run" }).click();
  await expect(page).toHaveURL(/\/apply-review\?jobKey=job-northwind-platform(?:&|$)/);
  await expect(page.getByRole("heading", { name: "Application review" })).toBeVisible();

  await openGuide.click();
  await guide.getByRole("link", { name: "See simulated run history" }).click();
  await expect(page).toHaveURL(/\/runs(?:\?|$)/);
  await expect(page.getByRole("heading", { name: "Workflow runs" })).toBeVisible();

  const before = await resetEpoch(page);
  await openGuide.click();
  await guide.getByRole("button", { name: "Reset synthetic demo data" }).click();
  await expect(page.getByRole("dialog", { name: "Reset synthetic demo data?" })).toBeVisible();
  await page.getByRole("button", { name: "Reset demo data" }).click();
  await expect(guide.getByRole("status")).toContainText(
    "Synthetic demo data reset. The seeded examples are ready again.",
  );
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/);
  await expect.poll(() => resetEpoch(page)).toBe(before + 1);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(guide).toBeVisible();
  const guideBounds = await guide.boundingBox();
  expect(guideBounds).not.toBeNull();
  expect(guideBounds!.x).toBeGreaterThanOrEqual(0);
  expect(guideBounds!.x + guideBounds!.width).toBeLessThanOrEqual(390);
  expect(guideBounds!.y + guideBounds!.height).toBeLessThanOrEqual(844);
});

scenarioTest("Dashboard Failures opens the failed job counted by the KPI", async ({ page }) => {
  await page.goto("/dashboard");
  const failuresKpi = page
    .locator(".kpis")
    .getByRole("link", { name: /^Failures\b/i });

  await expect(failuresKpi).toContainText("1");
  await failuresKpi.click();

  await expect(page).toHaveURL(/\/jobs\?.*\bstate=failed\b/);
  await expect(page.getByRole("heading", { name: "Jobs" })).toBeVisible();
  await expect(page.getByText("1 shown / 1 total", { exact: true })).toBeVisible();
  await expect(jobRow(page, "Systems delivery director")).toContainText(
    "failed",
  );
  await expect(page.getByText("No jobs match.", { exact: true })).toHaveCount(
    0,
  );
});

scenarioTest("every P2 product route and seeded deep link renders populated across direct refreshes", async ({
  page,
  context,
  baseURL,
}) => {
  const demoOrigin = configuredOrigin(baseURL);
  const productRequests: string[] = [];
  const externalRequests: string[] = [];
  const runtimeErrors: string[] = [];
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/v1/")) {
      productRequests.push(url.pathname);
    }
    if (url.origin !== demoOrigin) {
      externalRequests.push(request.url());
    }
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));

  const routes = [
    ["/dashboard", "Dashboard", "3 jobs"],
    ["/jobs", "Jobs", "Platform systems lead"],
    ["/jobs/job-northwind-platform", "Job details", "Preparation diagnostics", "article"],
    ["/evidence-map", "Career evidence map", "Delivery improvement evidence"],
    ["/artifacts", "Artifacts", "Platform systems lead"],
    [
      "/artifacts/artifact-tailored-resume",
      "Artifact details",
      "Platform systems lead",
      "article",
    ],
    [
      "/apply-review?jobKey=job-northwind-platform",
      "Application review",
      "Materials ready",
    ],
    ["/runs", "Workflow runs", "Platform systems lead"],
    [
      "/runs/run-materials-progress",
      "Workflow run details",
      "Run details",
      "article",
    ],
    ["/analytics", "Outcome analytics", "bundled-capture"],
    ["/profile", "Profile", "Personal information"],
    ["/settings", "Settings", "Config"],
    ["/settings/credentials", "Settings", "Codex"],
    ["/outreach", "Contacts", "Synthetic hiring partner"],
    [
      "/outreach/contact-demo-hiring-partner",
      "Contact details",
      "Facts and provenance",
      "article",
    ],
    ["/discovery", "Discovery", "Bundled synthetic source"],
    ["/pipelines", "Pipelines", "Configuring"],
    ["/debug", "Debug", "Synthetic score recorded."],
    [
      "/activity/event-demo-score",
      "Synthetic score recorded.",
      "Projected event payload",
      "article",
    ],
  ] as const;

  for (const [route, identity, populatedText, role = "heading"] of routes) {
    await page.goto(STATIC_HOST);
    await page.goto(route);
    const identityLocator = visible(
      page,
      role === "article"
        ? page.getByRole("article", { name: identity, exact: true })
        : page.getByRole("heading", { name: identity, exact: true }),
    );
    const contentScope = role === "article" ? identityLocator : page.locator("main");
    const populatedLocator = visible(
      page,
      contentScope.getByText(populatedText, { exact: false }),
    );

    await expect(identityLocator).toHaveCount(1);
    await expect(identityLocator).toBeVisible();
    await expect(populatedLocator).not.toHaveCount(0);
    await expect(populatedLocator.first()).toBeVisible();
    expect(page.url()).toContain(route);

    await page.reload();
    await expect(identityLocator).toHaveCount(1);
    await expect(identityLocator).toBeVisible();
    await expect(populatedLocator).not.toHaveCount(0);
    await expect(populatedLocator.first()).toBeVisible();
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
  baseURL,
}) => {
  const demoOrigin = configuredOrigin(baseURL);
  const productRequests: string[] = [];
  const externalRequests: string[] = [];
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/v1/")) productRequests.push(url.pathname);
    if (url.origin !== demoOrigin) externalRequests.push(request.url());
  });
  const second = await context.newPage();

  await Promise.all([page.goto("/discovery"), second.goto("/discovery")]);
  const resultsPerBoard = page.getByRole("spinbutton", {
    name: "Results per board",
    exact: true,
  });
  const secondResultsPerBoard = second.getByRole("spinbutton", {
    name: "Results per board",
    exact: true,
  });
  await expect(resultsPerBoard).toHaveValue("12");
  await expect(secondResultsPerBoard).toHaveValue("12");
  await resultsPerBoard.fill("23");
  const discoveryForm = page.locator("form").filter({
    has: resultsPerBoard,
  });
  await discoveryForm
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(page.getByText("Runtime settings saved.")).toBeVisible();
  await expect(secondResultsPerBoard).toHaveValue("23");
  await second.reload();
  await expect(secondResultsPerBoard).toHaveValue("23");

  await Promise.all([page.goto("/settings"), second.goto("/settings")]);
  await expect(page.getByLabel("Concurrent applications")).toHaveValue("1");
  await expect(second.getByLabel("Concurrent applications")).toHaveValue("1");
  await page.getByLabel("Concurrent applications").fill("3");
  const executionForm = page.locator("form").filter({
    has: page.getByLabel("Concurrent applications"),
  });
  await executionForm.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(executionForm.getByRole("status")).toHaveText("Settings saved.");
  await expect(second.getByLabel("Concurrent applications")).toHaveValue("3");
  await second.reload();
  await expect(second.getByLabel("Concurrent applications")).toHaveValue("3");

  expect(productRequests).toEqual([]);
  expect(externalRequests).toEqual([]);
});

scenarioTest("discovery promotes a source and imports a manual capture through the real browser-local UI", async ({
  page,
  context,
  baseURL,
}) => {
  const demoOrigin = configuredOrigin(baseURL);
  const productRequests: string[] = [];
  const externalRequests: string[] = [];
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/v1/")) productRequests.push(url.pathname);
    if (url.origin !== demoOrigin) externalRequests.push(request.url());
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
  baseURL,
}) => {
  const demoOrigin = configuredOrigin(baseURL);
  const productRequests: string[] = [];
  const externalRequests: string[] = [];
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/v1/")) productRequests.push(url.pathname);
    if (url.origin !== demoOrigin) externalRequests.push(request.url());
  });

  const second = await context.newPage();
  await Promise.all([
    page.goto("/jobs/job-northwind-platform"),
    second.goto("/jobs/job-northwind-platform"),
  ]);
  await expect(page.getByText("8/10", { exact: true })).toBeVisible();
  await expect(second.getByText("8/10", { exact: true })).toBeVisible();

  const scoreEvidence = page.locator("details").filter({
    has: page.locator("summary", { hasText: "Score evidence and controls" }),
  });
  const scoreEvidenceToggle = scoreEvidence.locator(":scope > summary");
  await expect(scoreEvidenceToggle).toHaveText("Score evidence and controls");
  await expect(scoreEvidence).not.toHaveAttribute("open", "");
  await scoreEvidenceToggle.click();
  await expect(scoreEvidence).toHaveAttribute("open", "");

  await scoreEvidence.getByLabel("Correct score").fill("9");
  await scoreEvidence.getByLabel("Reason").fill("Reviewed bundled synthetic evidence");
  await scoreEvidence.getByRole("button", { name: "Save score correction" }).click();
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

scenarioTest("an older seed refreshes once and clears generated browser state", async ({
  page,
}) => {
  const initialized = await initializeWorkspace(page);
  expect(initialized.kind).toBe("ready");
  if (initialized.kind !== "ready") return;
  await page.evaluate(async () => {
    const workspace = window.__jobctrlDemoWorkspace;
    if (!workspace) throw new Error("workspace not initialized");
    await workspace.putBlob(
      "outdated-seed-preview",
      new Blob(["outdated synthetic edit"], { type: "text/plain" }),
    );
    await workspace.mutate((draft) => {
      (draft as unknown as { schemaVersion: number }).schemaVersion = 3;
      (draft as unknown as { seedVersion: string }).seedVersion =
        "2026-07-11.1";
      (draft.state as { title: string }).title =
        "Mutated previous synthetic seed";
    });
    workspace.dispose();
    delete window.__jobctrlDemoWorkspace;
  });
  const stale = initialized.snapshot;

  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  const refreshed = await initializeWorkspace(page);

  expect(refreshed.kind).toBe("ready");
  if (refreshed.kind !== "ready") return;
  expect(refreshed.snapshot).toMatchObject({
    schemaVersion: 4,
    seedVersion: CURRENT_DEMO_SEED_VERSION,
    resetCount: stale.resetCount + 1,
    resetEpoch: stale.resetEpoch + 1,
    pendingScenarios: [],
    blobIds: [],
    state: { title: "JobCtrl product tour" },
  });
  expect(refreshed.snapshot.workspaceId).not.toBe(stale.workspaceId);
  expect(
    await page.evaluate(async () => {
      if (!window.__jobctrlDemoWorkspace)
        throw new Error("workspace not initialized");
      return (
        (await window.__jobctrlDemoWorkspace.blob(
          "outdated-seed-preview",
        )) === null
      );
    }),
  ).toBe(true);

  const refreshedWorkspaceId = refreshed.snapshot.workspaceId;
  await page.reload();
  const reloaded = await initializeWorkspace(page);
  expect(reloaded).toMatchObject({
    kind: "ready",
    snapshot: {
      seedVersion: CURRENT_DEMO_SEED_VERSION,
      workspaceId: refreshedWorkspaceId,
      resetCount: stale.resetCount + 1,
      resetEpoch: stale.resetEpoch + 1,
    },
  });
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
