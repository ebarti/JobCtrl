import { ExtensionCaptureIngestSchema, type ExtensionCaptureIngestRequest } from "@jobctrl/contracts";

import { detectSupportedAts } from "./ats";
import { getBrowserApi, type BrowserApi, type BrowserTab } from "./browser";
import { checkLocalApiReady, getExtensionAutofillProfile, LocalApiError, postExtensionCapture } from "./local-api";
import { clearCaptureQueue, enqueueCapture, flushCaptureQueue, loadCaptureQueue } from "./queue";

const TOKEN_STORAGE_KEY = "jobctrlExtensionCapabilityToken";

type BackgroundMessage =
  | { type: "captureCurrentTab" }
  | { type: "clearQueue" }
  | { type: "getStatus" }
  | { type: "reviewAutofill" }
  | { type: "saveToken"; token: string };

type BackgroundResponse =
  | { ok: true; status: "captured"; jobKey: string | null; queueSize: number }
  | { ok: true; status: "queued"; queueSize: number; message: string }
  | { ok: true; status: "ready"; paired: boolean; apiReady: boolean; queueSize: number }
  | { ok: true; status: "review_opened"; suggestions: number; missing: number }
  | { ok: true; status: "token_saved" }
  | { ok: false; error: string; message: string };

const browserApi = getBrowserApi();

browserApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleMessage(browserApi, message).then(sendResponse, (error: unknown) => {
    sendResponse(errorResponse(error));
  });
  return true;
});

async function handleMessage(browser: BrowserApi, message: unknown): Promise<BackgroundResponse> {
  if (!isBackgroundMessage(message)) {
    return { ok: false, error: "unknown_message", message: "Unsupported extension request." };
  }
  switch (message.type) {
    case "captureCurrentTab":
      return captureCurrentTab(browser);
    case "clearQueue":
      await clearCaptureQueue(browser.storage.local);
      return { ok: true, status: "ready", paired: Boolean(await readToken(browser)), apiReady: true, queueSize: 0 };
    case "getStatus": {
      const [token, queue, apiReady] = await Promise.all([
        readToken(browser),
        loadCaptureQueue(browser.storage.local),
        checkLocalApiReady(),
      ]);
      return { ok: true, status: "ready", paired: Boolean(token), apiReady, queueSize: queue.length };
    }
    case "reviewAutofill":
      return reviewAutofill(browser);
    case "saveToken": {
      const token = message.token.trim();
      if (!token) {
        return { ok: false, error: "missing_token", message: "Paste the pairing token from JobCtrl Settings." };
      }
      await browser.storage.local.set({ [TOKEN_STORAGE_KEY]: token });
      await clearCaptureQueue(browser.storage.local);
      return { ok: true, status: "token_saved" };
    }
  }
}

async function reviewAutofill(browser: BrowserApi): Promise<BackgroundResponse> {
  const token = await readToken(browser);
  if (!token) {
    return { ok: false, error: "not_paired", message: "Pair the extension with JobCtrl before autofill." };
  }
  const tab = await activeTab(browser);
  if (!tab.id || !detectSupportedAts(tab.url)) {
    return { ok: false, error: "unsupported_ats", message: "Open a supported ATS application form first." };
  }
  try {
    const profile = await getExtensionAutofillProfile(token);
    const response = await browser.tabs.sendMessage<BackgroundResponse>(tab.id, {
      type: "jobctrl.autofill.review",
      profile,
    });
    return response;
  } catch (error) {
    if (error instanceof LocalApiError && (error.status === 401 || error.status === 403)) {
      return {
        ok: false,
        error: "pairing_token_rejected",
        message: "JobCtrl rejected the pairing token. Copy a fresh token from Settings.",
      };
    }
    return {
      ok: false,
      error: "autofill_unavailable",
      message: error instanceof Error ? error.message : "Unable to open autofill review on this page.",
    };
  }
}

async function captureCurrentTab(browser: BrowserApi): Promise<BackgroundResponse> {
  const token = await readToken(browser);
  if (!token) {
    return { ok: false, error: "not_paired", message: "Pair the extension with JobCtrl before capturing." };
  }
  const tab = await activeTab(browser);
  if (!tab.id || !isHttpUrl(tab.url)) {
    return { ok: false, error: "unsupported_page", message: "JobCtrl can capture only http(s) pages." };
  }
  const snapshot = await readPageSnapshot(browser, tab.id);
  const capture = ExtensionCaptureIngestSchema.parse({
    captureId: crypto.randomUUID(),
    originatingUrl: tab.url,
    captureMode: "current_page",
    capturedUrl: tab.url,
    contentText: snapshot.text,
    ...(snapshot.title ? { note: `Captured from ${snapshot.title}` } : {}),
    futureManualActionRequired: false,
    captureClient: "browser_extension",
    extensionVersion: browser.runtime.getManifest().version ?? "unknown",
  } satisfies ExtensionCaptureIngestRequest);

  try {
    const response = await postExtensionCapture(token, capture);
    const flush = await flushCaptureQueue(browser.storage.local, token);
    return {
      ok: true,
      status: "captured",
      jobKey: response.jobKey,
      queueSize: flush.remaining,
    };
  } catch (error) {
    if (error instanceof LocalApiError && (error.status === 401 || error.status === 403)) {
      return {
        ok: false,
        error: "pairing_token_rejected",
        message: "JobCtrl rejected the pairing token. Copy a fresh token from Settings.",
      };
    }
    const queued = await enqueueCapture(browser.storage.local, capture);
    return {
      ok: true,
      status: "queued",
      queueSize: queued.queueSize,
      message: error instanceof Error ? error.message : "Local JobCtrl API is unavailable.",
    };
  }
}

async function activeTab(browser: BrowserApi): Promise<BrowserTab> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    throw new Error("No active browser tab found.");
  }
  return tab;
}

async function readToken(browser: BrowserApi): Promise<string | null> {
  const value = (await browser.storage.local.get(TOKEN_STORAGE_KEY))[TOKEN_STORAGE_KEY];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function readPageSnapshot(browser: BrowserApi, tabId: number): Promise<{ title: string; text: string }> {
  const [result] = await browser.scripting.executeScript({
    target: { tabId },
    func: () => ({
      title: document.title,
      text: (document.body?.innerText ?? document.documentElement?.textContent ?? "").slice(0, 200_000),
    }),
  });
  const snapshot = result?.result;
  if (!snapshot?.text?.trim()) {
    throw new Error("The current page did not expose readable text.");
  }
  return {
    title: snapshot.title?.slice(0, 180) ?? "",
    text: snapshot.text,
  };
}

function isBackgroundMessage(value: unknown): value is BackgroundMessage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === "captureCurrentTab" ||
    candidate.type === "clearQueue" ||
    candidate.type === "getStatus" ||
    candidate.type === "reviewAutofill" ||
    (candidate.type === "saveToken" && typeof candidate.token === "string")
  );
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function errorResponse(error: unknown): BackgroundResponse {
  return {
    ok: false,
    error: "extension_error",
    message: error instanceof Error ? error.message : "The extension request failed.",
  };
}
