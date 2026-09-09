import "./popup.css";

import { getBrowserApi } from "./browser";
import { EXTENSION_MESSAGE_PROTOCOL_VERSION } from "./message-protocol";

const browserApi = getBrowserApi();

const apiState = requiredElement("api-state");
const autofillButton = requiredButton("autofill");
const captureButton = requiredButton("capture");
const clearQueueButton = requiredButton("clear-queue");
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
        setStatus(response.jobKey ? `Saved to JobCtrl: ${response.jobKey}` : "Saved to JobCtrl.");
      } else if (response.ok && response.status === "queued") {
        setStatus(`Queued locally. ${response.queueSize} capture(s) waiting.`);
      } else if (!response.ok) {
        setStatus(response.message);
      }
      return refreshStatus({ preserveStatus: true });
    })
    .finally(() => {
      captureButton.disabled = false;
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
    setStatus(response.ok ? "Local capture queue cleared." : response.message);
    return refreshStatus({ preserveStatus: true });
  });
});

async function refreshStatus(options: { preserveStatus?: boolean } = {}): Promise<void> {
  const response = await sendMessage({ type: "getStatus" });
  if (!response.ok) {
    apiState.textContent = "Unavailable";
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
  selectDiscoveryButton.hidden = !response.paired || !response.apiReady || response.discoverySelected;
  selectDiscoveryButton.disabled = selectDiscoveryButton.hidden;
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
    setStatus(`${response.queueSize} queued capture(s) will sync after the next save.`);
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
