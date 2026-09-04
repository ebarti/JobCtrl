import { chromium, type BrowserContext, type Page, type Request, type Route, type Worker } from "@playwright/test";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIST = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../dist/extension");
const LOOPBACK_ORIGIN = "http://127.0.0.1:8766";

interface RecordedRequest {
  method: string | undefined;
  path: string | undefined;
  url: string;
}

interface FakeLoopbackApi {
  requests: RecordedRequest[];
  discoveryCompletions: unknown[];
  close(): Promise<void>;
}

interface FakeDiscoverySource {
  baseUrl: string;
  liveProfileCookieSeen(): boolean;
  privateRedirectTargetSeen(): boolean;
  close(): Promise<void>;
}

describe("Chromium loaded extension privacy boundary", () => {
  it("runs a JSON API request from the live profile when the source root is not injectable HTML", async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-extension-e2e-"));
    let api: FakeLoopbackApi | null = null;
    let context: BrowserContext | null = null;
    let source: FakeDiscoverySource | null = null;
    try {
      source = await startFakeDiscoverySource();
      context = await launchExtensionContext(userDataDir);
      if (!context) {
        return;
      }
      api = await installFakeLoopbackApi(context, `${source.baseUrl}/api/jobs`);
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 10_000 }));
      const extensionId = new URL(worker.url()).host;
      const extensionHttpRequests: string[] = [];
      context.on("request", (request) => {
        if (isExtensionInitiatedHttpRequest(request, extensionId)) {
          extensionHttpRequests.push(request.url());
        }
      });

      await context.addCookies([
        {
          name: "jobctrl_session_probe",
          value: "live-profile",
          domain: "careers.jobctrl.test",
          path: "/",
          secure: false,
          sameSite: "Lax",
        },
      ]);

      const controller = await context.newPage();
      await controller.goto(`chrome-extension://${extensionId}/popup.html`);
      await controller.locator("#token-input").fill("token-1");
      await controller.locator("#save-token").click();
      await controller.waitForFunction(() =>
        document.querySelector("#api-state")?.textContent?.includes("Discovery connected"),
      );
      expect(await controller.locator("#api-state").textContent()).not.toContain("undefined");
      expect(await sendExtensionMessage(controller, { type: "getStatus" })).toMatchObject({
        ok: true,
        status: "ready",
        protocolVersion: 1,
        paired: true,
        apiReady: true,
        discoverySelected: true,
        installationIdSuffix: expect.stringMatching(/^[0-9a-f]{8}$/i),
      });

      await waitFor(() => api?.discoveryCompletions.length === 1, 25_000);
      if ((api.discoveryCompletions[0] as { result?: { status?: string } }).result?.status !== "succeeded") {
        throw new Error(`Discovery completion failed: ${JSON.stringify(api.discoveryCompletions[0])}`);
      }
      expect(api.discoveryCompletions[0]).toMatchObject({
        result: {
          status: "succeeded",
          finalUrl: `${source.baseUrl}/api/jobs`,
          bodyText: '{"jobs":[{"id":"fixture-role"}]}',
        },
      });
      expect(source.liveProfileCookieSeen()).toBe(true);

      const capturePage = await context.newPage();
      await capturePage.goto(`${LOOPBACK_ORIGIN}/synthetic-capture`);
      await capturePage.bringToFront();
      const capture = await sendExtensionMessage(controller, { type: "captureCurrentTab" });
      expect(capture).toMatchObject({ ok: true, status: "captured", jobKey: "synthetic-job" });

      const applicationPage = await context.newPage();
      await applicationPage.goto(`${source.baseUrl}/acme/senior-platform-engineer`);
      await applicationPage.bringToFront();
      await applicationPage.waitForSelector("input[name='email']");
      expect(await applicationPage.locator("#jobctrl-autofill-root").count()).toBe(0);
      expect(await applicationPage.locator("input[name='email']").inputValue()).toBe("");
      const autofill = await sendAutofillReviewFromExtensionPage(controller);
      expect(autofill).toMatchObject({ ok: true, status: "review_opened", suggestions: 1, missing: 0 });
      expect(await applicationPage.locator("input[name='email']").inputValue()).toBe("");
      await expectPageText(applicationPage, "Profile value ready");

      expect(api.requests.map((request) => `${request.method} ${request.path}`)).toContain("POST /v1/extension/captures");
      expect(api.requests.map((request) => `${request.method} ${request.path}`)).toContain(
        "GET /v1/extension/autofill/profile",
      );
      expect(extensionHttpRequests).toEqual(expect.arrayContaining([
        `${LOOPBACK_ORIGIN}/v1/extension/captures`,
        `${LOOPBACK_ORIGIN}/v1/extension/autofill/profile`,
        `${source.baseUrl}/api/jobs`,
      ]));
      expect(
        extensionHttpRequests.every(
          (url) =>
            url.startsWith(`${LOOPBACK_ORIGIN}/`) ||
            url.startsWith("http://localhost:8766/") ||
            url === `${source?.baseUrl}/api/jobs`,
        ),
      ).toBe(true);
    } finally {
      await api?.close();
      await context?.close();
      await source?.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("hard-times out a hanging live-profile HTTP request without leaving a temporary tab", async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-extension-timeout-e2e-"));
    let api: FakeLoopbackApi | null = null;
    let context: BrowserContext | null = null;
    let source: FakeDiscoverySource | null = null;
    try {
      source = await startFakeDiscoverySource();
      context = await launchExtensionContext(userDataDir);
      if (!context) return;
      api = await installFakeLoopbackApi(context, `${source.baseUrl}/hang`, 1_000);
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 10_000 }));
      const controller = await context.newPage();
      await controller.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);

      await sendExtensionMessage(controller, { type: "saveToken", token: "token-timeout" });
      await waitFor(() => api?.discoveryCompletions.length === 1, 8_000);

      expect(api.discoveryCompletions[0]).toMatchObject({
        result: { status: "failed", errorCode: "request_failed", retryable: true },
      });
      expect(context.pages().filter((page) => page.url().startsWith(source?.baseUrl ?? "")).length).toBe(0);
    } finally {
      await api?.close();
      await context?.close();
      await source?.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("blocks a public-to-loopback redirect before the private target is requested", async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-extension-redirect-e2e-"));
    let api: FakeLoopbackApi | null = null;
    let context: BrowserContext | null = null;
    let source: FakeDiscoverySource | null = null;
    try {
      source = await startFakeDiscoverySource();
      context = await launchExtensionContext(userDataDir);
      if (!context) return;
      api = await installFakeLoopbackApi(context, `${source.baseUrl}/redirect-private`);
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 10_000 }));
      const controller = await context.newPage();
      await controller.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);

      await sendExtensionMessage(controller, { type: "saveToken", token: "token-redirect" });
      await waitFor(() => api?.discoveryCompletions.length === 1, 10_000);

      expect(api.discoveryCompletions[0]).toMatchObject({ result: { status: "failed" } });
      expect(source.privateRedirectTargetSeen()).toBe(false);
    } finally {
      await api?.close();
      await context?.close();
      await source?.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  }, 60_000);
});

async function launchExtensionContext(userDataDir: string): Promise<BrowserContext | null> {
  try {
    return await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${DIST}`,
        `--load-extension=${DIST}`,
        "--host-resolver-rules=MAP careers.jobctrl.test 127.0.0.1",
      ],
    });
  } catch (error) {
    if (isHeadedBrowserUnavailable(error)) {
      console.warn(`Skipping headed Chromium extension e2e: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    throw error;
  }
}

function isHeadedBrowserUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Missing X server") ||
    message.includes("no DISPLAY") ||
    message.includes("Host system is missing dependencies")
  );
}

async function sendExtensionMessage(page: Page, message: unknown): Promise<unknown> {
  return page.evaluate(
    (payload) =>
      new Promise((resolve) => {
        (globalThis as unknown as { chrome: { runtime: { sendMessage(message: unknown, callback: (response: unknown) => void): void } } }).chrome.runtime.sendMessage(
          payload,
          resolve,
        );
      }),
    message,
  );
}

async function sendAutofillReviewFromExtensionPage(page: Page): Promise<unknown> {
  let lastError = "";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await sendExtensionMessage(page, { type: "reviewAutofill" });
    if (isSuccessfulAutofillResponse(response)) {
      return response;
    }
    lastError = typeof response === "object" && response ? String((response as { message?: unknown }).message ?? "") : String(response);
    await page.waitForTimeout(150);
  }
  throw new Error(`Extension autofill review did not reach the content script: ${lastError}`);
}

function isSuccessfulAutofillResponse(response: unknown): boolean {
  return Boolean(
    response &&
      typeof response === "object" &&
      (response as { ok?: unknown; status?: unknown }).ok === true &&
      (response as { status?: unknown }).status === "review_opened",
  );
}

async function expectPageText(page: Page, expected: string): Promise<void> {
  await page.waitForFunction((text) => document.body.textContent?.includes(text), expected);
}

function isExtensionInitiatedHttpRequest(request: Request, extensionId: string): boolean {
  if (!request.url().startsWith("http://") && !request.url().startsWith("https://")) {
    return false;
  }
  const extensionBase = `chrome-extension://${extensionId}/`;
  const serviceWorker = request.serviceWorker();
  if (serviceWorker?.url().startsWith(extensionBase)) {
    return true;
  }
  try {
    return request.frame().url().startsWith(extensionBase);
  } catch {
    return false;
  }
}

async function installFakeLoopbackApi(
  context: BrowserContext,
  discoveryUrl: string,
  taskTimeoutMs = 15_000,
): Promise<FakeLoopbackApi> {
  const requests: RecordedRequest[] = [];
  const discoveryCompletions: unknown[] = [];
  let discoveryTaskLeased = false;
  const headers = {
    "access-control-allow-headers": "authorization,content-type,x-jobctrl-extension-installation,x-jobctrl-extension-version",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-origin": "*",
  };
  const handler = async (route: Route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    requests.push({
      method: request.method(),
      path: requestUrl.pathname,
      url: requestUrl.href,
    });
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }
    if (requestUrl.pathname === "/synthetic-capture") {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<!doctype html><title>Synthetic job</title><main>Visible role description</main>",
      });
      return;
    }
    if (requestUrl.pathname === "/favicon.ico") {
      await route.fulfill({ status: 404, headers });
      return;
    }
    if (requestUrl.pathname === "/v1/health") {
      await json(route, { ok: true }, headers);
      return;
    }
    if (requestUrl.pathname === "/v1/extension/discovery/claim") {
      await json(route, { ok: true, installationBound: true, selected: true }, headers);
      return;
    }
    if (requestUrl.pathname === "/v1/extension/discovery/tasks/next") {
      if (discoveryTaskLeased) {
        await json(route, { ok: true, status: "idle" }, headers);
        return;
      }
      discoveryTaskLeased = true;
      await json(route, {
        ok: true,
        status: "task",
        taskId: "discover-browser:live-profile-e2e",
        leaseId: "00000000-0000-4000-8000-000000000001",
        timeoutMs: taskTimeoutMs,
        request: {
          mode: "http_request",
          url: discoveryUrl,
          method: "GET",
          headers: { Accept: "application/json" },
        },
      }, headers);
      return;
    }
    if (/^\/v1\/extension\/discovery\/tasks\/[^/]+\/lease$/.test(requestUrl.pathname)) {
      await json(route, { ok: true, active: true }, headers);
      return;
    }
    if (/^\/v1\/extension\/discovery\/tasks\/[^/]+\/result$/.test(requestUrl.pathname)) {
      discoveryCompletions.push(request.postDataJSON());
      await json(route, { ok: true }, headers);
      return;
    }
    if (requestUrl.pathname === "/v1/extension/captures") {
      await json(route, {
        ok: true,
        itemId: "extension-capture-1",
        jobKey: "synthetic-job",
        importedAt: "2026-07-05T10:00:00Z",
        provenance: {
          sourceKind: "user_mediated_capture",
          originatingUrl: `${LOOPBACK_ORIGIN}/synthetic-capture`,
          captureMode: "current_page",
          futureManualActionRequired: false,
        },
      }, headers);
      return;
    }
    if (requestUrl.pathname === "/v1/extension/autofill/profile") {
      await json(route, {
        ok: true,
        profileVersion: 1,
        fields: [
          {
            path: "personal.email",
            label: "Profile > Personal information > Email",
            value: "jordan@example.com",
            source: { kind: "profile", path: "personal.email", label: "Email" },
          },
        ],
      }, headers);
      return;
    }
    await json(route, { ok: false, error: "not_found" }, headers, 404);
  };
  await context.route(`${LOOPBACK_ORIGIN}/**`, handler);
  return {
    requests,
    discoveryCompletions,
    close: () => context.unroute(`${LOOPBACK_ORIGIN}/**`, handler),
  };
}

async function startFakeDiscoverySource(): Promise<FakeDiscoverySource> {
  let cookieSeen = false;
  let privateRedirectSeen = false;
  const privateTarget: Server = createServer((_request, response) => {
    privateRedirectSeen = true;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("private target must remain unreachable");
  });
  await new Promise<void>((resolve, reject) => {
    privateTarget.once("error", reject);
    privateTarget.listen(0, "127.0.0.1", resolve);
  });
  const privateAddress = privateTarget.address();
  if (!privateAddress || typeof privateAddress === "string") {
    throw new Error("Synthetic private redirect target did not expose a TCP port.");
  }
  const server: Server = createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(401, { "content-type": "text/plain" });
      response.end("API root does not host an injectable HTML document");
      return;
    }
    if (request.url === "/api/jobs") {
      cookieSeen = String(request.headers.cookie ?? "").includes(
        "jobctrl_session_probe=live-profile",
      );
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"jobs":[{"id":"fixture-role"}]}');
      return;
    }
    if (request.url === "/hang") {
      return;
    }
    if (request.url === "/redirect-private") {
      response.writeHead(302, { location: `http://127.0.0.1:${privateAddress.port}/private` });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`
      <!doctype html>
      <html>
        <head><title>Synthetic generic application</title></head>
        <body>
          <form id="application">
            <label>Email <input name="email" /></label>
          </form>
        </body>
      </html>
    `);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Synthetic Discovery source did not expose a TCP port.");
  }
  return {
    baseUrl: `http://careers.jobctrl.test:${address.port}`,
    liveProfileCookieSeen: () => cookieSeen,
    privateRedirectTargetSeen: () => privateRedirectSeen,
    close: async () => {
      await Promise.all([
        closeServer(server),
        closeServer(privateTarget),
      ]);
    },
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the extension Discovery task.");
}

async function json(route: Route, body: unknown, headers: Record<string, string>, status = 200): Promise<void> {
  await route.fulfill({ status, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
}
