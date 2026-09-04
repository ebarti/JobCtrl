import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

const DIST = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../dist/extension");
const WEB_PAGE_MATCHES = new Set(["http://*/*", "https://*/*"]);
const FORBIDDEN_BUNDLE_PATTERNS = [/<all_urls>/, /fetch\(["'`]https?:\/\/(?!127\.0\.0\.1:8766|localhost:8766)/, /XMLHttpRequest/];
const MODULE_SYNTAX_PATTERN = /^\s*(?:import|export)\b/m;

type RuntimeListener = (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => boolean | void;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("built extension privacy boundary", () => {
  it("builds wildcard HTTP(S) page and brokered Discovery network access", () => {
    const files = distFiles(DIST);
    const manifest = JSON.parse(fs.readFileSync(path.join(DIST, "manifest.json"), "utf8")) as {
      permissions?: string[];
      host_permissions?: string[];
      content_scripts?: Array<{ matches?: string[] }>;
      content_security_policy?: { extension_pages?: string };
    };
    expect(new Set(manifest.permissions)).toEqual(
      new Set(["activeTab", "alarms", "declarativeNetRequest", "scripting", "storage"]),
    );
    expect(new Set(manifest.host_permissions)).toEqual(WEB_PAGE_MATCHES);
    expect(new Set(manifest.content_scripts?.[0]?.matches ?? [])).toEqual(WEB_PAGE_MATCHES);
    expect(manifest.content_security_policy?.extension_pages).toContain("connect-src http: https:");

    const bundle = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
    for (const pattern of FORBIDDEN_BUNDLE_PATTERNS) {
      expect(bundle).not.toMatch(pattern);
    }
  });

  it("emits a classic manifest content script that Chrome can inject", () => {
    const contentScript = fs.readFileSync(path.join(DIST, "content-script.js"), "utf8");

    expect(contentScript).not.toMatch(MODULE_SYNTAX_PATTERN);
    expect(contentScript).toContain("chrome.runtime.onMessage.addListener");
  });

  it("sends built runtime API requests only to loopback endpoints", async () => {
    const requests: string[] = [];
    const storage = createMemoryStorage();
    let listener: RuntimeListener | null = null;
    const sendMessage = vi.fn(async (_tabId: number, message: unknown) =>
      isAutofillProbe(message)
        ? { ok: true, status: "autofill_ready" }
        : { ok: true, status: "review_opened", suggestions: 1, missing: 0 },
    );
    vi.stubGlobal("chrome", {
      alarms: {
        create: vi.fn(),
        onAlarm: { addListener: vi.fn() },
      },
      runtime: {
        getManifest: () => ({ version: "0.3.0" }),
        sendMessage: vi.fn(),
        onMessage: {
          addListener: (candidate: RuntimeListener) => {
            listener = candidate;
          },
        },
      },
      scripting: {
        executeScript: vi.fn(async () => [{ result: { title: "Synthetic application", text: "Visible role description" } }]),
      },
      storage: { local: storage },
      tabs: {
        create: vi.fn(),
        query: vi.fn(async () => [{ id: 42, url: "https://careers.example.com/acme/senior-platform-engineer" }]),
        remove: vi.fn(),
        sendMessage,
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith("/v1/extension/captures")) {
          return jsonResponse({
            ok: true,
            itemId: "extension-1",
            jobKey: "https://careers.example.com/acme/senior-platform-engineer",
            importedAt: "2026-07-05T10:00:00Z",
            provenance: {
              sourceKind: "user_mediated_capture",
              originatingUrl: "https://careers.example.com/acme/senior-platform-engineer",
              captureMode: "current_page",
              futureManualActionRequired: false,
            },
          });
        }
        if (url.endsWith("/v1/extension/autofill/profile")) {
          return jsonResponse({ ok: true, profileVersion: 1, fields: [] });
        }
        return jsonResponse({ ok: true });
      }),
    );

    await import(`${pathToFileURL(path.join(DIST, "background.js")).href}?runtime=${Date.now()}`);
    expect(listener).not.toBeNull();

    await sendRuntimeMessage(listener, { type: "saveToken", token: "token-1" });
    const capture = await sendRuntimeMessage(listener, { type: "captureCurrentTab" });
    const autofill = await sendRuntimeMessage(listener, { type: "reviewAutofill" });

    expect(capture).toMatchObject({ ok: true, status: "captured" });
    expect(autofill).toMatchObject({ ok: true, status: "review_opened" });
    expect(sendMessage.mock.calls).toEqual([
      [42, { type: "jobctrl.autofill.probe" }],
      [42, expect.objectContaining({ type: "jobctrl.autofill.review" })],
    ]);
    expect(requests).toEqual(expect.arrayContaining([
      "http://127.0.0.1:8766/v1/extension/captures",
      "http://127.0.0.1:8766/v1/extension/autofill/profile",
      expect.stringContaining("/v1/extension/discovery/tasks/next"),
    ]));
    expect(
      requests.every((url) => url.startsWith("http://127.0.0.1:8766/") || url.startsWith("http://localhost:8766/")),
    ).toBe(true);
  });

  it("does not read profile data when the current page has no JobCtrl content script", async () => {
    const storage = createMemoryStorage();
    let listener: RuntimeListener | null = null;
    const sendMessage = vi.fn(async () => {
      throw new Error("No receiving end");
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      jsonResponse({ ok: true, profileVersion: 1, fields: [] }),
    );
    vi.stubGlobal("chrome", {
      alarms: {
        create: vi.fn(),
        onAlarm: { addListener: vi.fn() },
      },
      runtime: {
        getManifest: () => ({ version: "0.3.0" }),
        sendMessage: vi.fn(),
        onMessage: {
          addListener: (candidate: RuntimeListener) => {
            listener = candidate;
          },
        },
      },
      scripting: { executeScript: vi.fn() },
      storage: { local: storage },
      tabs: {
        create: vi.fn(),
        query: vi.fn(async () => [{ id: 42 }]),
        remove: vi.fn(),
        sendMessage,
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    await import(`${pathToFileURL(path.join(DIST, "background.js")).href}?missing-content-script=${Date.now()}`);
    expect(listener).not.toBeNull();

    await sendRuntimeMessage(listener, { type: "saveToken", token: "token-1" });
    const response = await sendRuntimeMessage(listener, { type: "reviewAutofill" });

    expect(response).toMatchObject({ ok: false, error: "unsupported_page" });
    expect(sendMessage).toHaveBeenCalledWith(42, { type: "jobctrl.autofill.probe" });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain(
      "http://127.0.0.1:8766/v1/extension/autofill/profile",
    );
  });
});

function isAutofillProbe(message: unknown): boolean {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as Record<string, unknown>).type === "jobctrl.autofill.probe",
  );
}

function distFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return distFiles(target);
    }
    return entry.isFile() ? [target] : [];
  });
}

function createMemoryStorage(): {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
} {
  const values = new Map<string, unknown>();
  return {
    async get(keys) {
      if (typeof keys === "string") {
        return { [keys]: values.get(keys) };
      }
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, values.get(key)]));
      }
      if (keys && typeof keys === "object") {
        return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, values.get(key) ?? fallback]));
      }
      return Object.fromEntries(values);
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) {
        values.set(key, value);
      }
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        values.delete(key);
      }
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function sendRuntimeMessage(listener: RuntimeListener | null, message: unknown): Promise<unknown> {
  expect(listener).not.toBeNull();
  return new Promise((resolve) => {
    listener?.(message, {}, resolve);
  });
}
