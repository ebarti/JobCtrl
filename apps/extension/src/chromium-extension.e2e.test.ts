import { chromium, type BrowserContext, type Page, type Request, type Worker } from "@playwright/test";
import http from "node:http";
import fs from "node:fs";
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

describe("Chromium loaded extension privacy boundary", () => {
  it("sends capture and autofill API requests only to loopback origins", async () => {
    const api = await startFakeLoopbackApi();
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunter-extension-e2e-"));
    let context: BrowserContext | null = null;
    try {
      context = await launchExtensionContext(userDataDir);
      if (!context) {
        return;
      }
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 10_000 }));
      const extensionId = new URL(worker.url()).host;
      const extensionHttpRequests: string[] = [];
      context.on("request", (request) => {
        if (isExtensionInitiatedHttpRequest(request, extensionId)) {
          extensionHttpRequests.push(request.url());
        }
      });

      await context.route("https://jobs.ashbyhq.com/**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `
            <!doctype html>
            <html>
              <head><title>Synthetic Ashby application</title></head>
              <body>
                <form id="application">
                  <label>Email <input name="email" /></label>
                </form>
              </body>
            </html>
          `,
        }),
      );

      const controller = await context.newPage();
      await controller.goto(`chrome-extension://${extensionId}/popup.html`);
      expect(await sendExtensionMessage(controller, { type: "saveToken", token: "token-1" })).toEqual({
        ok: true,
        status: "token_saved",
      });

      const capturePage = await context.newPage();
      await capturePage.goto(`${LOOPBACK_ORIGIN}/synthetic-capture`);
      await capturePage.bringToFront();
      const capture = await sendExtensionMessage(controller, { type: "captureCurrentTab" });
      expect(capture).toMatchObject({ ok: true, status: "captured", jobKey: "synthetic-job" });

      const atsPage = await context.newPage();
      await atsPage.goto("https://jobs.ashbyhq.com/acme/senior-platform-engineer");
      await atsPage.bringToFront();
      await atsPage.waitForSelector("input[name='email']");
      const autofill = await sendAutofillReviewFromExtensionPage(controller, "token-1");
      expect(autofill).toMatchObject({ ok: true, status: "review_opened", suggestions: 1, missing: 0 });
      expect(await atsPage.locator("input[name='email']").inputValue()).toBe("");
      await expectPageText(atsPage, "Profile value ready");

      expect(api.requests.map((request) => `${request.method} ${request.path}`)).toContain("POST /v1/extension/captures");
      expect(api.requests.map((request) => `${request.method} ${request.path}`)).toContain(
        "GET /v1/extension/autofill/profile",
      );
      expect(extensionHttpRequests).toEqual(expect.arrayContaining([
        `${LOOPBACK_ORIGIN}/v1/extension/captures`,
        `${LOOPBACK_ORIGIN}/v1/extension/autofill/profile`,
      ]));
      expect(
        extensionHttpRequests.every((url) => url.startsWith(`${LOOPBACK_ORIGIN}/`) || url.startsWith("http://localhost:8766/")),
      ).toBe(true);
    } finally {
      await context?.close();
      await api.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  }, 60_000);
});

async function launchExtensionContext(userDataDir: string): Promise<BrowserContext | null> {
  try {
    return await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
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

async function sendAutofillReviewFromExtensionPage(page: Page, token: string): Promise<unknown> {
  let lastError = "";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await page.evaluate(async (capabilityToken) => {
      try {
        const profile = await fetch("http://127.0.0.1:8766/v1/extension/autofill/profile", {
          headers: { authorization: `Bearer ${capabilityToken}` },
        }).then((candidate) => candidate.json());
        const [tab] = await (globalThis as unknown as {
          chrome: {
            tabs: {
              query(query: { active: true; currentWindow: true }): Promise<Array<{ id?: number }>>;
              sendMessage(tabId: number, message: unknown): Promise<unknown>;
            };
          };
        }).chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
          return { ok: false, error: "missing_tab", message: "No active tab." };
        }
        return await (globalThis as unknown as {
          chrome: { tabs: { sendMessage(tabId: number, message: unknown): Promise<unknown> } };
        }).chrome.tabs.sendMessage(tab.id, {
          type: "jobhunter.autofill.review",
          profile,
        });
      } catch (error) {
        return {
          ok: false,
          error: "autofill_probe_failed",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }, token);
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

async function startFakeLoopbackApi(): Promise<{
  requests: RecordedRequest[];
  close(): Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", LOOPBACK_ORIGIN);
    requests.push({
      method: request.method,
      path: requestUrl.pathname,
      url: requestUrl.href,
    });
    const headers = {
      "access-control-allow-headers": "authorization,content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-origin": "*",
    };
    if (request.method === "OPTIONS") {
      response.writeHead(204, headers);
      response.end();
      return;
    }
    if (requestUrl.pathname === "/synthetic-capture") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Synthetic job</title><main>Visible role description</main>");
      return;
    }
    if (requestUrl.pathname === "/favicon.ico") {
      response.writeHead(404, headers);
      response.end();
      return;
    }
    if (requestUrl.pathname === "/v1/health") {
      json(response, { ok: true }, headers);
      return;
    }
    if (requestUrl.pathname === "/v1/extension/captures") {
      json(response, {
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
      json(response, {
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
    json(response, { ok: false, error: "not_found" }, headers, 404);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(8766, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function json(response: http.ServerResponse, body: unknown, headers: Record<string, string>, status = 200): void {
  response.writeHead(status, { ...headers, "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
