import "./popup.css";

import { getBrowserApi } from "./browser";
import { EXTENSION_MESSAGE_PROTOCOL_VERSION } from "./message-protocol";
import type { ExtensionCaptureIngestRequest } from "@jobctrl/contracts";

const browserApi = getBrowserApi();

const apiState = requiredElement("api-state");
const autofillButton = requiredButton("autofill");
const captureButton = requiredButton("capture");
const clearQueueButton = requiredButton("clear-queue");
const retryQueueButton = requiredButton("retry-queue");
const reviewQueueButton = requiredButton("review-queue");
const discardQueuedButton = requiredButton("discard-queued");
const queueReview = requiredElement("queue-review");
const queueSelection = requiredElement("queue-selection") as HTMLSelectElement;
const queueContent = requiredElement("queue-content") as HTMLTextAreaElement;
const queueUrl = requiredElement("queue-url");
const queueNote = requiredElement("queue-note");
const queueState = requiredElement("queue-state");
let queueReviewRequest = 0;
let queueDetailRequest = 0;
const saveTokenButton = requiredButton("save-token");
const selectDiscoveryButton = requiredButton("select-discovery");
const statusText = requiredElement("status");
const tokenInput = requiredInput("token-input");

setProtocolControlsEnabled(false);
void refreshStatus();

saveTokenButton.addEventListener("click", () => {
  void sendMessage({ type: "saveToken", token: tokenInput.value }).then((response) => {
    if (response.ok && response.status === "token_saved") {
      tokenInput.value = "";
      setStatus("Pairing token saved and this Chrome profile selected for Discovery.");
    } else {
      setStatus(response.ok ? "The extension returned an unexpected pairing response." : response.message);
    }
    return refreshStatus({ preserveStatus: true });
  });
});

selectDiscoveryButton.addEventListener("click", () => {
  selectDiscoveryButton.disabled = true;
  setStatus("Selecting this Chrome profile for Discovery...");
  void sendMessage({ type: "selectDiscoveryProfile" })
    .then((response) => {
      if (response.ok && response.status === "profile_selected") {
        setStatus("This Chrome profile is now selected for Discovery.");
      } else {
        setStatus(response.ok ? "The extension returned an unexpected selection response." : response.message);
      }
      return refreshStatus({ preserveStatus: true });
    })
    .finally(() => {
      selectDiscoveryButton.disabled = false;
    });
});

captureButton.addEventListener("click", () => {
  captureButton.disabled = true;
  setStatus("Saving current page...");
  void sendMessage({ type: "captureCurrentTab" })
    .then((response) => {
      if (response.ok && response.status === "captured") {
        const saved = response.jobKey ? `Saved to JobCtrl: ${response.jobKey}` : "Saved to JobCtrl.";
        setStatus(response.queueSize > 0 ? `${saved} ${response.queueSize} capture(s) still queued.` : saved);
      } else if (response.ok && response.status === "queued") {
        setStatus(`Queued locally. ${response.queueSize} capture(s) waiting. ${response.message}`);
      } else if (!response.ok) {
        setStatus(response.message);
      }
      return refreshStatus({ preserveStatus: true });
    });
});

autofillButton.addEventListener("click", () => {
  autofillButton.disabled = true;
  setStatus("Opening autofill review...");
  void sendMessage({ type: "reviewAutofill" })
    .then((response) => {
      if (response.ok && response.status === "review_opened") {
        setStatus(`Review opened with ${response.suggestions} suggestion(s) and ${response.missing} missing profile value(s).`);
      } else if (!response.ok) {
        setStatus(response.message);
      }
      return refreshStatus({ preserveStatus: true });
    })
    .finally(() => {
      autofillButton.disabled = false;
    });
});

clearQueueButton.addEventListener("click", () => {
  void sendMessage({ type: "clearQueue" }).then((response) => {
    if (response.ok) { queueReviewRequest += 1; queueDetailRequest += 1; queueReview.hidden = true; clearQueuePreview(); }
    setStatus(response.ok ? "Local capture queue cleared." : response.message);
    return refreshStatus({ preserveStatus: true });
  });
});

reviewQueueButton.addEventListener("click", () => { void refreshQueueReview(); });

queueSelection.addEventListener("change", () => {
  void loadQueuedCapture(queueSelection.value);
});

async function loadQueuedCapture(id: string): Promise<void> {
  const request = ++queueDetailRequest;
  clearQueuePreview();
  if (!id) return;
  const response = await sendMessage({ type: "getQueuedCapture", id });
  if (request !== queueDetailRequest || queueSelection.value !== id) return;
  if (response.ok && response.status === "queue_item" && response.item) {
    queueUrl.textContent = response.item.capturedUrl ?? response.item.originatingUrl;
    queueState.textContent = response.reviewStatus === "superseded" ? "Superseded: this capture cannot sync. Review it before discarding." : "Queued or syncing.";
    queueContent.value = savedCaptureContent(response.item);
    queueNote.textContent = response.item.note ?? "";
    discardQueuedButton.disabled = false;
  } else {
    setStatus(response.ok ? "That capture is no longer queued." : response.message);
  }
}

discardQueuedButton.addEventListener("click", () => {
  const id = queueSelection.value;
  if (!id) return;
  queueSelection.disabled = true;
  discardQueuedButton.disabled = true;
  void sendMessage({ type: "discardQueuedCapture", id }).then(async (response) => {
    setStatus(response.ok && response.status === "queue_item_discarded"
      ? response.removed ? "Selected capture discarded locally." : "That capture is no longer queued."
      : response.ok ? "The extension returned an unexpected queue response." : response.message);
    await refreshStatus({ preserveStatus: true });
  }).finally(() => { queueSelection.disabled = false; });
});

async function refreshQueueReview(): Promise<void> {
  const request = ++queueReviewRequest;
  const response = await sendMessage({ type: "reviewQueue" });
  if (request !== queueReviewRequest) return;
  if (!response.ok || response.status !== "queue_items") {
    setStatus(response.ok ? "The extension returned an unexpected queue response." : response.message);
    return;
  }
  const selection = queueSelection.value;
  queueReview.hidden = false;
  queueSelection.replaceChildren(new Option("Select a capture", ""));
  for (const item of response.items) {
    const option = new Option(`${item.originatingUrl} · ${item.queuedAt} · ${item.reviewStatus === "superseded" ? "Superseded" : "Queued or syncing"}`, item.id);
    queueSelection.add(option);
  }
  queueSelection.value = response.items.some((item) => item.id === selection) ? selection : "";
  await loadQueuedCapture(queueSelection.value);
}

function clearQueuePreview(): void {
  queueContent.value = "";
  queueUrl.textContent = "";
  queueNote.textContent = "";
  queueState.textContent = "";
  discardQueuedButton.disabled = true;
}

function savedCaptureContent(capture: ExtensionCaptureIngestRequest): string {
  if (capture.contentText) return capture.contentText;
  if (!capture.contentHtmlBase64) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(capture.contentHtmlBase64), (character) => character.charCodeAt(0)));
  } catch { return capture.contentHtmlBase64; }
}

retryQueueButton.addEventListener("click", () => {
  retryQueueButton.disabled = true;
  setStatus("Syncing queued captures...");
  void sendMessage({ type: "retryQueue" }).then((response) => {
    if (response.ok && response.status === "queue_flushed") {
      const detail = response.message ? ` ${response.message}` : "";
      setStatus(`${response.flushed} capture(s) synced. ${response.queueSize} still queued.${detail}`);
    } else {
      setStatus(response.ok ? "The extension returned an unexpected sync response." : response.message);
    }
    return refreshStatus({ preserveStatus: true });
  });
});

async function refreshStatus(options: { preserveStatus?: boolean } = {}): Promise<void> {
  const response = await sendMessage({ type: "getStatus" });
  if (!response.ok) {
    if (response.error === "capture_queue_unavailable") {
      setProtocolControlsEnabled(true);
      captureButton.disabled = true;
      autofillButton.disabled = true;
      retryQueueButton.disabled = true;
      reviewQueueButton.disabled = true;
      clearQueueButton.disabled = false;
      apiState.textContent = "Local capture queue unavailable";
    } else {
      apiState.textContent = "Unavailable";
    }
    if (!options.preserveStatus) {
      setStatus(response.message);
    }
    return;
  }
  if (response.status !== "ready") {
    return;
  }
  if (!isCurrentReadyResponse(response)) {
    showVersionSkew();
    return;
  }
  setProtocolControlsEnabled(true);
  apiState.textContent = `${response.apiReady ? "Local app ready" : "Local app down"} · ${response.discoverySelected ? "Discovery connected" : "Discovery not selected"} · installation …${response.installationIdSuffix}`;
  autofillButton.disabled = !response.paired;
  captureButton.disabled = !response.paired;
  clearQueueButton.disabled = response.queueSize === 0;
  retryQueueButton.disabled = !response.paired || response.queueSize === 0;
  reviewQueueButton.disabled = response.queueSize === 0;
  selectDiscoveryButton.hidden = !response.paired || !response.apiReady || response.discoverySelected;
  selectDiscoveryButton.disabled = selectDiscoveryButton.hidden;
  if (!queueReview.hidden) await refreshQueueReview();
  if (options.preserveStatus) {
    return;
  }
  if (!response.paired) {
    setStatus("Paste the pairing token from JobCtrl Settings.");
  } else if (!response.apiReady) {
    setStatus(`Local app is down. ${response.queueSize} queued capture(s).`);
  } else if (!response.discoverySelected) {
    setStatus("The token is saved, but Discovery is not using this Chrome profile. Select it below.");
  } else if (response.queueSize > 0) {
    setStatus(`${response.queueSize} queued capture(s). Select Sync queued captures to retry.`);
  } else {
    setStatus("Ready to save the current page.");
  }
}

function showVersionSkew(): void {
  setProtocolControlsEnabled(false);
  apiState.textContent = "Extension update incomplete";
  setStatus(
    "Chrome is still running an older JobCtrl background. Reload the unpacked JobCtrl extension in chrome://extensions, then reopen this popup.",
  );
}

function setProtocolControlsEnabled(enabled: boolean): void {
  tokenInput.disabled = !enabled;
  saveTokenButton.disabled = !enabled;
  autofillButton.disabled = !enabled;
  captureButton.disabled = !enabled;
  clearQueueButton.disabled = !enabled;
  retryQueueButton.disabled = !enabled;
  reviewQueueButton.disabled = !enabled;
  discardQueuedButton.disabled = true;
  selectDiscoveryButton.hidden = true;
  selectDiscoveryButton.disabled = true;
}

function isCurrentReadyResponse(
  response: Extract<PopupResponse, { status: "ready" }>,
): response is CurrentReadyResponse {
  return (
    response.protocolVersion === EXTENSION_MESSAGE_PROTOCOL_VERSION &&
    typeof response.paired === "boolean" &&
    typeof response.apiReady === "boolean" &&
    typeof response.discoverySelected === "boolean" &&
    typeof response.queueSize === "number" &&
    typeof response.installationIdSuffix === "string" &&
    /^[0-9a-f]{8}$/i.test(response.installationIdSuffix)
  );
}

async function sendMessage(message: unknown): Promise<PopupResponse> {
  return browserApi.runtime.sendMessage<PopupResponse>(message);
}

function setStatus(message: string): void {
  statusText.textContent = message;
}

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing popup element #${id}.`);
  }
  return element;
}

function requiredButton(id: string): HTMLButtonElement {
  const element = requiredElement(id);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`#${id} is not a button.`);
  }
  return element;
}

function requiredInput(id: string): HTMLInputElement {
  const element = requiredElement(id);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`#${id} is not an input.`);
  }
  return element;
}

type PopupResponse =
  | { ok: true; status: "captured"; jobKey: string | null; queueSize: number }
  | { ok: true; status: "queued"; queueSize: number; message: string }
  | { ok: true; status: "queue_flushed"; flushed: number; queueSize: number; message: string | null }
  | { ok: true; status: "queue_items"; items: Array<{ id: string; queuedAt: string; originatingUrl: string; reviewStatus: "pending" | "superseded" }> }
  | { ok: true; status: "queue_item"; item: ExtensionCaptureIngestRequest | null; reviewStatus: "pending" | "superseded" | null }
  | { ok: true; status: "queue_item_discarded"; removed: boolean }
  | {
      ok: true;
      status: "ready";
      protocolVersion?: unknown;
      paired?: unknown;
      apiReady?: unknown;
      discoverySelected?: unknown;
      queueSize?: unknown;
      installationIdSuffix?: unknown;
    }
  | { ok: true; status: "review_opened"; suggestions: number; missing: number }
  | { ok: true; status: "profile_selected" }
  | { ok: true; status: "token_saved" }
  | { ok: false; error: string; message: string };

interface CurrentReadyResponse {
  ok: true;
  status: "ready";
  protocolVersion: number;
  paired: boolean;
  apiReady: boolean;
  discoverySelected: boolean;
  queueSize: number;
  installationIdSuffix: string;
}
