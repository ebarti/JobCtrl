import { ExtensionCaptureIngestSchema, type ExtensionCaptureIngestRequest } from "@jobctrl/contracts";

import { getBrowserApi, type BrowserApi, type BrowserTab } from "./browser";
import { processNextDiscoveryBrowserTask } from "./discovery-loop";
import { EXTENSION_MESSAGE_PROTOCOL_VERSION } from "./message-protocol";
import {
  checkLocalApiReady,
  claimDiscoveryBrowserInstallation,
  getExtensionAutofillProfile,
  LocalApiError,
  postExtensionCapture,
} from "./local-api";
import { clearCaptureQueue, enqueueCapture, flushCaptureQueue, loadCaptureQueue } from "./queue";

const TOKEN_STORAGE_KEY = "jobctrlExtensionCapabilityToken";
const INSTALLATION_STORAGE_KEY = "jobctrlDiscoveryInstallationId";
const DISCOVERY_POLL_ALARM = "jobctrlDiscoveryBrowserPoll";
const DISCOVERY_EXECUTOR_COUNT = 4;

type BackgroundMessage =
  | { type: "captureCurrentTab" }
  | { type: "clearQueue" }
  | { type: "getStatus" }
  | { type: "reviewAutofill" }
  | { type: "selectDiscoveryProfile" }
  | { type: "saveToken"; token: string };

type BackgroundResponse =
  | { ok: true; status: "captured"; jobKey: string | null; queueSize: number }
  | { ok: true; status: "queued"; queueSize: number; message: string }
  | {
      ok: true;
      status: "ready";
      protocolVersion: number;
      paired: boolean;
      apiReady: boolean;
      discoverySelected: boolean;
      queueSize: number;
      installationIdSuffix: string;
    }
  | { ok: true; status: "review_opened"; suggestions: number; missing: number }
  | { ok: true; status: "profile_selected" }
  | { ok: true; status: "token_saved" }
  | { ok: false; error: string; message: string };

type AutofillProbeResponse =
  | { ok: true; status: "autofill_ready" }
  | { ok: false; error: string; message: string };

const browserApi = getBrowserApi();
let discoveryPolling: Promise<void> | null = null;

browserApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleMessage(browserApi, message).then(sendResponse, (error: unknown) => {
    sendResponse(errorResponse(error));
  });
  return true;
});

if (import.meta.env.MODE !== "test") {
  browserApi.alarms.create(DISCOVERY_POLL_ALARM, {
    delayInMinutes: 0.1,
    periodInMinutes: 0.5,
  });
  browserApi.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === DISCOVERY_POLL_ALARM) {
      wakeDiscoveryPolling(browserApi);
    }
  });
  wakeDiscoveryPolling(browserApi);
}

async function handleMessage(browser: BrowserApi, message: unknown): Promise<BackgroundResponse> {
  if (!isBackgroundMessage(message)) {
    return { ok: false, error: "unknown_message", message: "Unsupported extension request." };
  }
  switch (message.type) {
    case "captureCurrentTab":
      return captureCurrentTab(browser);
    case "clearQueue":
      await clearCaptureQueue(browser.storage.local);
      return getReadyStatus(browser);
    case "getStatus":
      return getReadyStatus(browser);
    case "reviewAutofill":
      return reviewAutofill(browser);
    case "saveToken": {
      const token = message.token.trim();
      if (!token) {
        return { ok: false, error: "missing_token", message: "Paste the pairing token from JobCtrl Settings." };
      }
      const installationId = await getOrCreateInstallationId(browser);
      const extensionVersion = browser.runtime.getManifest().version ?? "unknown";
      await claimDiscoveryBrowserInstallation(token, {
        installationId,
        extensionVersion,
        replace: true,
      });
      await browser.storage.local.set({ [TOKEN_STORAGE_KEY]: token });
      await clearCaptureQueue(browser.storage.local);
      wakeDiscoveryPolling(browser);
      return { ok: true, status: "token_saved" };
    }
    case "selectDiscoveryProfile": {
      const token = await readToken(browser);
      if (!token) {
        return { ok: false, error: "not_paired", message: "Paste and save the pairing token first." };
      }
      const installationId = await getOrCreateInstallationId(browser);
      const extensionVersion = browser.runtime.getManifest().version ?? "unknown";
      await claimDiscoveryBrowserInstallation(token, {
        installationId,
        extensionVersion,
        replace: true,
      });
      wakeDiscoveryPolling(browser);
      return { ok: true, status: "profile_selected" };
    }
  }
}

async function getReadyStatus(browser: BrowserApi): Promise<Extract<BackgroundResponse, { status: "ready" }>> {
  const [token, queue, apiReady, installationId] = await Promise.all([
    readToken(browser),
    loadCaptureQueue(browser.storage.local),
    checkLocalApiReady(),
    getOrCreateInstallationId(browser),
  ]);
  const extensionVersion = browser.runtime.getManifest().version ?? "unknown";
  const discoverySelected = Boolean(
    token &&
      apiReady &&
      (await isDiscoveryInstallationSelected(token, installationId, extensionVersion)),
  );
  if (discoverySelected) {
    wakeDiscoveryPolling(browser);
  }
  return {
    ok: true,
    status: "ready",
    protocolVersion: EXTENSION_MESSAGE_PROTOCOL_VERSION,
    paired: Boolean(token),
    apiReady,
    discoverySelected,
    queueSize: queue.length,
    installationIdSuffix: installationId.slice(-8),
  };
}

async function isDiscoveryInstallationSelected(
  token: string,
  installationId: string,
  extensionVersion: string,
): Promise<boolean> {
  try {
    await claimDiscoveryBrowserInstallation(token, {
      installationId,
      extensionVersion,
      replace: false,
    });
    return true;
  } catch (error) {
    if (
      error instanceof LocalApiError &&
      (error.status === 401 || error.status === 403 || error.status === 409)
    ) {
      return false;
    }
    return false;
  }
}

function wakeDiscoveryPolling(browser: BrowserApi): void {
  if (discoveryPolling) return;
  const loop = runDiscoveryPollingPool(browser).finally(() => {
    if (discoveryPolling === loop) {
      discoveryPolling = null;
    }
  });
  discoveryPolling = loop;
}

async function runDiscoveryPollingPool(browser: BrowserApi): Promise<void> {
  const token = await readToken(browser);
  if (!token) return;
  const installationId = await getOrCreateInstallationId(browser);
  const extensionVersion = browser.runtime.getManifest().version ?? "unknown";
  try {
    await claimDiscoveryBrowserInstallation(token, {
      installationId,
      extensionVersion,
      replace: false,
    });
  } catch (error) {
    if (
      error instanceof LocalApiError &&
      (error.status === 401 || error.status === 403 || error.status === 409)
    ) {
      return;
    }
    throw error;
  }
  await Promise.all(
    Array.from({ length: DISCOVERY_EXECUTOR_COUNT }, () =>
      runDiscoveryPollingLoop(browser, token, installationId, extensionVersion),
    ),
  );
}

async function runDiscoveryPollingLoop(
  browser: BrowserApi,
  token: string,
  installationId: string,
  extensionVersion: string,
): Promise<void> {
  let failureBackoffMs = 1_000;
  while (true) {
    try {
      const outcome = await processNextDiscoveryBrowserTask(
        browser,
        token,
        installationId,
        extensionVersion,
      );
      failureBackoffMs = 1_000;
      await delay(outcome === "processed" ? 100 : 2_000);
    } catch (error) {
      if (
        error instanceof LocalApiError &&
        (error.status === 401 || error.status === 403 || error.status === 409)
      ) {
        return;
      }
      await delay(failureBackoffMs);
      failureBackoffMs = Math.min(failureBackoffMs * 2, 15_000);
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function reviewAutofill(browser: BrowserApi): Promise<BackgroundResponse> {
  const token = await readToken(browser);
  if (!token) {
    return { ok: false, error: "not_paired", message: "Pair the extension with JobCtrl before autofill." };
  }
  const tab = await activeTab(browser);
  if (!tab.id || (tab.url !== undefined && !isHttpUrl(tab.url))) {
    return { ok: false, error: "unsupported_page", message: "Open an http(s) application form first." };
  }
  try {
    const probe = await browser.tabs.sendMessage<AutofillProbeResponse>(tab.id, {
      type: "jobctrl.autofill.probe",
    });
    if (!probe.ok || probe.status !== "autofill_ready") {
      return { ok: false, error: "unsupported_page", message: "JobCtrl autofill is not available on this page." };
    }
  } catch {
    return { ok: false, error: "unsupported_page", message: "JobCtrl autofill is not available on this page." };
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

async function getOrCreateInstallationId(browser: BrowserApi): Promise<string> {
  const stored = (await browser.storage.local.get(INSTALLATION_STORAGE_KEY))[
    INSTALLATION_STORAGE_KEY
  ];
  if (
    typeof stored === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      stored,
    )
  ) {
    return stored;
  }
  const installationId = crypto.randomUUID();
  await browser.storage.local.set({ [INSTALLATION_STORAGE_KEY]: installationId });
  return installationId;
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
    candidate.type === "selectDiscoveryProfile" ||
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
