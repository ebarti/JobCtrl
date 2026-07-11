import { expect, test, type Page } from "@playwright/test";

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

declare global {
  interface Window {
    __jobctrlDemoWorkspace?: DemoWorkspaceRepository;
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

test.beforeEach(async ({ page }) => {
  await page.goto(STATIC_HOST);
});

test("demo shell renders the shared-profile and personal-data boundary without product network", async ({
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

test("same-context tabs share, serialize concurrent writes, and survive reload without product network", async ({
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

test("separate browser contexts isolate workspaces", async ({
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

test("reset rotates identity, fences state, and deletes generated blobs", async ({
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

test("future native database version is upgrade-required without downgrade", async ({
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

test("postcommit event adapter emits only valid ordered domain events", async ({
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
