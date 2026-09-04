import type {
  DiscoveryBrowserRequest,
  DiscoveryBrowserTaskLeaseResponse,
  DiscoveryBrowserTaskResult,
} from "@jobctrl/contracts";

import type { BrowserApi, BrowserDeclarativeNetRequestRule } from "./browser";

type LeasedDiscoveryTask = Extract<DiscoveryBrowserTaskLeaseResponse, { status: "task" }>;
type DiscoveryProbeResponse = { ok: true; status: "discovery_ready" };

export interface DiscoveryBrowserExecutionOptions {
  signal?: AbortSignal;
}

/**
 * Execute one brokered task in an inactive tab in the Chrome profile where the
 * extension is installed. A tab-scoped DNR allow/block pair is installed before
 * navigation, so cross-origin redirects are blocked before their request is
 * dispatched. The tab is closed on success, failure, cancellation, or timeout.
 */
export async function executeDiscoveryBrowserTask(
  browser: BrowserApi,
  task: LeasedDiscoveryTask,
  options: DiscoveryBrowserExecutionOptions = {},
): Promise<DiscoveryBrowserTaskResult> {
  const destination = new URL(task.request.url);
  const contextUrl =
    task.request.mode === "rendered_page"
      ? task.request.url
      : `${destination.origin}/`;
  const controller = new AbortController();
  let abortKind: "timeout" | "canceled" | null = null;
  const onExternalAbort = () => {
    abortKind = "canceled";
    controller.abort(options.signal?.reason);
  };
  if (options.signal?.aborted) {
    onExternalAbort();
  } else {
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timeout = setTimeout(() => {
    if (!controller.signal.aborted) {
      abortKind = "timeout";
      controller.abort(new Error("Discovery browser task timed out."));
    }
  }, task.timeoutMs);

  let tabId: number | null = null;
  let ruleIds: number[] = [];
  try {
    if (task.request.mode === "http_request") {
      return await executeExtensionHttpRequest(task.request, controller.signal);
    }
    const tab = await withAbort(
      browser.tabs.create({ active: false, url: "about:blank" }),
      controller.signal,
    );
    if (!tab.id) {
      return failed("navigation_failed", "Chrome did not create a Discovery tab.", true);
    }
    tabId = tab.id;
    const rules = redirectGuardRules(task, tabId, destination.origin);
    ruleIds = rules.map((rule) => rule.id);
    await withAbort(
      browser.declarativeNetRequest.updateSessionRules({
        removeRuleIds: ruleIds,
        addRules: rules,
      }),
      controller.signal,
    );
    await withAbort(
      browser.tabs.update(tabId, { active: false, url: contextUrl }),
      controller.signal,
    );
    await waitForContentScript(browser, tabId, controller.signal);
    const result = await withAbort(
      browser.tabs.sendMessage<DiscoveryBrowserTaskResult>(tabId, {
        type: "jobctrl.discovery.snapshot",
      }),
      controller.signal,
    );
    return sameOriginResult(task, result);
  } catch (error) {
    if (controller.signal.aborted) {
      const message =
        abortKind === "timeout"
          ? `Discovery browser task exceeded its ${task.timeoutMs} ms timeout.`
          : "Discovery browser task was canceled by the worker.";
      return failed(
        task.request.mode === "rendered_page" ? "navigation_failed" : "request_failed",
        message,
        true,
      );
    }
    return failed(
      task.request.mode === "rendered_page" ? "navigation_failed" : "request_failed",
      error instanceof Error ? error.message : "Chrome could not execute the Discovery task.",
      true,
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onExternalAbort);
    if (tabId !== null) {
      try {
        await browser.tabs.remove(tabId);
      } catch {
        // Chrome may already have closed a failed or canceled navigation tab.
      }
    }
    if (ruleIds.length > 0) {
      try {
        await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds });
      } catch {
        // Session rules are also cleared when the extension is reloaded.
      }
    }
  }
}

/**
 * Execute a brokered HTTP request in the extension service worker. API hosts
 * frequently expose JSON/plain-text roots (or redirect their root elsewhere),
 * so they cannot reliably host a content script. This still uses the current
 * Chrome profile's cookie jar, but does not require an injectable page.
 *
 * Redirect following is deliberately disabled. The API validates the initial
 * public destination before leasing the task; refusing redirects prevents that
 * validated request from reaching a second origin before it can be checked.
 */
async function executeExtensionHttpRequest(
  request: Extract<DiscoveryBrowserRequest, { mode: "http_request" }>,
  signal: AbortSignal,
): Promise<DiscoveryBrowserTaskResult> {
  let target: URL;
  try {
    target = new URL(request.url);
  } catch {
    return failed("unsupported_page", "The Discovery URL is invalid.", false);
  }
  if (!isSafePublicPageUrl(target)) {
    return failed("unsupported_page", "Discovery browser requests require a public HTTP(S) URL.", false);
  }
  try {
    const response = await fetch(target.href, {
      method: request.method,
      headers: sanitizeDiscoveryHeaders(request.headers),
      ...(request.method === "POST" && request.body !== undefined ? { body: request.body } : {}),
      credentials: "include",
      cache: "no-store",
      redirect: "manual",
      signal,
    });
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      return failed(
        "unsafe_redirect",
        "Chrome blocked a Discovery HTTP redirect before following it.",
        false,
      );
    }
    const finalUrl = new URL(response.url || target.href);
    if (!isSafePublicPageUrl(finalUrl) || finalUrl.origin !== target.origin) {
      return failed(
        "unsafe_redirect",
        "Chrome blocked a Discovery HTTP result outside the validated source origin.",
        false,
      );
    }
    const bodyText = await readBoundedResponseText(response, 4_000_000);
    return {
      status: "succeeded",
      finalUrl: finalUrl.href,
      statusCode: response.status,
      contentType: response.headers.get("content-type")?.slice(0, 300) ?? "",
      title: "",
      browserUserAgent: navigator.userAgent.slice(0, 500),
      bodyText,
    };
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof DiscoveryResponseTooLargeError) {
      return failed("response_too_large", error.message, false);
    }
    return failed(
      "request_failed",
      error instanceof Error ? error.message : "Chrome could not execute the Discovery HTTP request.",
      true,
    );
  }
}

function sanitizeDiscoveryHeaders(headers: Record<string, string>): Record<string, string> {
  const forbidden = new Set([
    "connection",
    "content-length",
    "cookie",
    "host",
    "origin",
    "referer",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "user-agent",
  ]);
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => {
        const normalized = name.toLowerCase();
        return (
          !forbidden.has(normalized) &&
          !normalized.startsWith("sec-") &&
          !normalized.startsWith("proxy-")
        );
      })
      .slice(0, 32)
      .map(([name, value]) => [name, String(value).slice(0, 4096)]),
  );
}

class DiscoveryResponseTooLargeError extends Error {
  constructor() {
    super("Discovery response exceeded 4 MB of UTF-8 data.");
    this.name = "DiscoveryResponseTooLargeError";
  }
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new DiscoveryResponseTooLargeError();
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("Discovery response exceeded its byte limit.");
        throw new DiscoveryResponseTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function isSafePublicPageUrl(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (/^(?:127\.|0\.|10\.|169\.254\.|192\.168\.)/.test(host)) return false;
  const private172 = /^172\.(\d{1,3})\./.exec(host);
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return false;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return false;
  return true;
}

async function waitForContentScript(
  browser: BrowserApi,
  tabId: number,
  signal: AbortSignal,
): Promise<void> {
  let lastError: unknown;
  while (!signal.aborted) {
    try {
      const probe = await withAbort(
        browser.tabs.sendMessage<DiscoveryProbeResponse>(tabId, {
          type: "jobctrl.discovery.probe",
        }),
        signal,
      );
      if (probe?.ok && probe.status === "discovery_ready") {
        return;
      }
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
    }
    await delay(200, signal);
  }
  throw (
    lastError instanceof Error
      ? new Error(`Discovery content script did not become ready: ${lastError.message}`)
      : new Error("Discovery content script did not become ready before its timeout.")
  );
}

function redirectGuardRules(
  task: LeasedDiscoveryTask,
  tabId: number,
  origin: string,
): BrowserDeclarativeNetRequestRule[] {
  const baseId = discoveryRuleBase(task.taskId, task.leaseId);
  const resourceTypes: Array<"main_frame" | "xmlhttprequest"> = [
    "main_frame",
    "xmlhttprequest",
  ];
  return [
    {
      id: baseId,
      priority: 10,
      action: { type: "allow" },
      condition: {
        regexFilter: `^${escapeRegex(origin)}/`,
        resourceTypes,
        tabIds: [tabId],
      },
    },
    {
      id: baseId + 1,
      priority: 1,
      action: { type: "block" },
      condition: {
        regexFilter: "^https?://",
        resourceTypes,
        tabIds: [tabId],
      },
    },
  ];
}

function discoveryRuleBase(taskId: string, leaseId: string): number {
  let hash = 2_166_136_261;
  for (const character of `${taskId}:${leaseId}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return 100_000_000 + (hash % 500_000_000) * 2;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sameOriginResult(
  task: LeasedDiscoveryTask,
  result: DiscoveryBrowserTaskResult,
): DiscoveryBrowserTaskResult {
  if (result.status !== "succeeded") return result;
  try {
    if (new URL(result.finalUrl).origin === new URL(task.request.url).origin) {
      return result;
    }
  } catch {
    // Fall through to the fail-closed result.
  }
  return failed(
    "unsafe_redirect",
    "Chrome blocked a Discovery redirect outside the validated source origin.",
    false,
  );
}

function failed(
  errorCode: Extract<DiscoveryBrowserTaskResult, { status: "failed" }>["errorCode"],
  message: string,
  retryable: boolean,
): DiscoveryBrowserTaskResult {
  return {
    status: "failed",
    errorCode,
    message: message.trim().slice(0, 500) || "Discovery browser request failed.",
    retryable,
  };
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error("Discovery browser task aborted."));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Discovery browser task aborted."));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return withAbort(
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
    signal,
  );
}
