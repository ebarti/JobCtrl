import "./popup.css";

import { getBrowserApi } from "./browser";

const browserApi = getBrowserApi();

const apiState = requiredElement("api-state");
const captureButton = requiredButton("capture");
const clearQueueButton = requiredButton("clear-queue");
const saveTokenButton = requiredButton("save-token");
const statusText = requiredElement("status");
const tokenInput = requiredInput("token-input");

void refreshStatus();

saveTokenButton.addEventListener("click", () => {
  void sendMessage({ type: "saveToken", token: tokenInput.value }).then((response) => {
    if (response.ok) {
      tokenInput.value = "";
      setStatus("Pairing token saved.");
    } else {
      setStatus(response.message);
    }
    return refreshStatus();
  });
});

captureButton.addEventListener("click", () => {
  captureButton.disabled = true;
  setStatus("Saving current page...");
  void sendMessage({ type: "captureCurrentTab" })
    .then((response) => {
      if (response.ok && response.status === "captured") {
        setStatus(response.jobKey ? `Saved to JobHunter: ${response.jobKey}` : "Saved to JobHunter.");
      } else if (response.ok && response.status === "queued") {
        setStatus(`Queued locally. ${response.queueSize} capture(s) waiting.`);
      } else if (!response.ok) {
        setStatus(response.message);
      }
      return refreshStatus();
    })
    .finally(() => {
      captureButton.disabled = false;
    });
});

clearQueueButton.addEventListener("click", () => {
  void sendMessage({ type: "clearQueue" }).then((response) => {
    setStatus(response.ok ? "Local capture queue cleared." : response.message);
    return refreshStatus();
  });
});

async function refreshStatus(): Promise<void> {
  const response = await sendMessage({ type: "getStatus" });
  if (!response.ok) {
    apiState.textContent = "Unavailable";
    setStatus(response.message);
    return;
  }
  if (response.status !== "ready") {
    return;
  }
  apiState.textContent = response.apiReady ? "Local app ready" : "Local app down";
  captureButton.disabled = !response.paired;
  clearQueueButton.disabled = response.queueSize === 0;
  if (!response.paired) {
    setStatus("Paste the pairing token from JobHunter Settings.");
  } else if (!response.apiReady) {
    setStatus(`Local app is down. ${response.queueSize} queued capture(s).`);
  } else if (response.queueSize > 0) {
    setStatus(`${response.queueSize} queued capture(s) will sync after the next save.`);
  } else {
    setStatus("Ready to save the current page.");
  }
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
  | { ok: true; status: "ready"; paired: boolean; apiReady: boolean; queueSize: number }
  | { ok: true; status: "token_saved" }
  | { ok: false; error: string; message: string };
