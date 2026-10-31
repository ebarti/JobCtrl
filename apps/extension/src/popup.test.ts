// @vitest-environment jsdom

import { EXTENSION_MESSAGE_PROTOCOL_VERSION } from "./message-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("extension popup", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = `
      <main>
        <span id="api-state">Checking</span>
        <input id="token-input" />
        <button id="save-token" type="button">Save</button>
        <button id="select-discovery" type="button" hidden>Use this Chrome profile for Discovery</button>
        <button id="capture" type="button">Save job</button>
        <button id="autofill" type="button">Review autofill</button>
        <button id="retry-queue" type="button">Sync queued captures</button>
        <button id="review-queue" type="button">Review queued captures</button>
        <button id="clear-queue" type="button">Clear queue</button>
        <section id="queue-review" hidden>
          <select id="queue-selection"></select>
          <p id="queue-state"></p><p id="queue-url"></p><textarea id="queue-content"></textarea><p id="queue-note"></p>
          <p>Discarding removes only the local copy and cannot recall a send in progress.</p>
          <button id="discard-queued" type="button" disabled>Discard selected capture</button>
        </section>
        <p id="status" role="status"></p>
      </main>
    `;
  });

  it("preserves successful autofill feedback after refreshing readiness state", async () => {
    const sendMessage = stubRuntimeMessages([
      { ok: true, status: "ready", protocolVersion: EXTENSION_MESSAGE_PROTOCOL_VERSION, paired: true, apiReady: true, discoverySelected: true, queueSize: 0, installationIdSuffix: "00000099" },
      { ok: true, status: "review_opened", suggestions: 2, missing: 1 },
      { ok: true, status: "ready", protocolVersion: EXTENSION_MESSAGE_PROTOCOL_VERSION, paired: true, apiReady: true, discoverySelected: true, queueSize: 0, installationIdSuffix: "00000099" },
    ]);

    await import("./popup");
    await flushMicrotasks();
    document.getElementById("autofill")?.click();
    await flushMicrotasks();

    expect(sendMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "getStatus" },
      { type: "reviewAutofill" },
      { type: "getStatus" },
    ]);
    expect(document.getElementById("status")?.textContent).toBe(
      "Review opened with 2 suggestion(s) and 1 missing profile value(s).",
    );
    expect(document.getElementById("api-state")?.textContent).toContain(
      "Discovery connected · installation …00000099",
    );
  });

  it("preserves successful capture feedback after refreshing readiness state", async () => {
    const sendMessage = stubRuntimeMessages([
      { ok: true, status: "ready", protocolVersion: EXTENSION_MESSAGE_PROTOCOL_VERSION, paired: true, apiReady: true, discoverySelected: true, queueSize: 0, installationIdSuffix: "00000099" },
      { ok: true, status: "captured", jobKey: "job-123", queueSize: 0 },
      { ok: true, status: "ready", protocolVersion: EXTENSION_MESSAGE_PROTOCOL_VERSION, paired: true, apiReady: true, discoverySelected: true, queueSize: 0, installationIdSuffix: "00000099" },
    ]);

    await import("./popup");
    await flushMicrotasks();
    document.getElementById("capture")?.click();
    await flushMicrotasks();

    expect(sendMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "getStatus" },
      { type: "captureCurrentTab" },
      { type: "getStatus" },
    ]);
    expect(document.getElementById("status")?.textContent).toBe("Saved to JobCtrl: job-123");
  });

  it("reports that older captures remain queued after saving the current page", async () => {
    stubRuntimeMessages([
      { ok: true, status: "ready", protocolVersion: EXTENSION_MESSAGE_PROTOCOL_VERSION, paired: true, apiReady: true, discoverySelected: true, queueSize: 1, installationIdSuffix: "00000099" },
      { ok: true, status: "captured", jobKey: "job-123", queueSize: 1 },
      { ok: true, status: "ready", protocolVersion: EXTENSION_MESSAGE_PROTOCOL_VERSION, paired: true, apiReady: true, discoverySelected: true, queueSize: 1, installationIdSuffix: "00000099" },
    ]);
    await import("./popup");
    await flushMicrotasks();
    document.getElementById("capture")?.click();
    await flushMicrotasks();
    expect(document.getElementById("status")?.textContent).toBe("Saved to JobCtrl: job-123 1 capture(s) still queued.");
  });

  it("offers explicit clear when an unreadable queue prevents readiness", async () => {
    stubRuntimeMessages([
      { ok: false, error: "capture_queue_unavailable", message: "The local capture queue is unreadable. Its stored data was kept; use Clear queue only to discard it." },
      { ok: true, status: "ready", protocolVersion: EXTENSION_MESSAGE_PROTOCOL_VERSION, paired: true, apiReady: true, discoverySelected: true, queueSize: 0, installationIdSuffix: "00000099" },
      { ok: true, status: "ready", protocolVersion: EXTENSION_MESSAGE_PROTOCOL_VERSION, paired: true, apiReady: true, discoverySelected: true, queueSize: 0, installationIdSuffix: "00000099" },
    ]);
    await import("./popup");
    await flushMicrotasks();
    expect(document.getElementById("api-state")?.textContent).toBe("Local capture queue unavailable");
    expect((document.getElementById("capture") as HTMLButtonElement).disabled).toBe(true);
    const clear = document.getElementById("clear-queue") as HTMLButtonElement;
    expect(clear.disabled).toBe(false);
    clear.click();
    await flushMicrotasks();
    expect(document.getElementById("status")?.textContent).toBe("Local capture queue cleared.");
  });

  it("offers an explicit retry for a full queue without discarding pending captures", async () => {
    const sendMessage = stubRuntimeMessages([
      { ok: true, status: "ready", protocolVersion: EXTENSION_MESSAGE_PROTOCOL_VERSION, paired: true, apiReady: true, discoverySelected: true, queueSize: 25, installationIdSuffix: "00000099" },
      { ok: true, status: "queue_flushed", flushed: 24, queueSize: 1, message: "Local JobCtrl API is unavailable." },
      { ok: true, status: "ready", protocolVersion: EXTENSION_MESSAGE_PROTOCOL_VERSION, paired: true, apiReady: true, discoverySelected: true, queueSize: 1, installationIdSuffix: "00000099" },
    ]);
    await import("./popup");
    await flushMicrotasks();
    const retry = document.getElementById("retry-queue") as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    retry.click();
    await flushMicrotasks();
    expect(sendMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "getStatus" }, { type: "retryQueue" }, { type: "getStatus" },
    ]);
    expect(document.getElementById("status")?.textContent).toBe("24 capture(s) synced. 1 still queued. Local JobCtrl API is unavailable.");
    expect(retry.disabled).toBe(false);
  });

  it("lets the user inspect and discard one retained capture without clearing the queue", async () => {
    const ready = { ok: true, status: "ready", protocolVersion: EXTENSION_MESSAGE_PROTOCOL_VERSION,
      paired: true, apiReady: true, discoverySelected: true, queueSize: 2, installationIdSuffix: "00000099" };
    const old = { id: "old", queuedAt: "2020-01-01T00:00:00Z", originatingUrl: "https://example.test/old", reviewStatus: "superseded" };
    const other = { id: "other", queuedAt: "2020-01-02T00:00:00Z", originatingUrl: "https://example.test/other", reviewStatus: "pending" };
    const sendMessage = stubRuntimeMessages([
      ready, { ok: true, status: "queue_items", items: [old, other] },
      { ok: true, status: "queue_item", reviewStatus: "superseded", item: { originatingUrl: old.originatingUrl, captureMode: "current_page",
        contentText: "Saved private synthetic page", note: "Synthetic note", futureManualActionRequired: false,
        captureClient: "browser_extension", extensionVersion: "1" } },
      { ok: true, status: "queue_item_discarded", removed: true }, { ...ready, queueSize: 1 },
      { ok: true, status: "queue_items", items: [other] },
    ]);
    await import("./popup");
    await flushMicrotasks();
    document.getElementById("review-queue")?.click();
    await flushMicrotasks();
    const select = document.getElementById("queue-selection") as HTMLSelectElement;
    select.value = "old";
    select.dispatchEvent(new Event("change"));
    await flushMicrotasks();
    expect((document.getElementById("queue-content") as HTMLTextAreaElement).value).toBe("Saved private synthetic page");
    expect(document.getElementById("queue-note")?.textContent).toBe("Synthetic note");
    expect(document.getElementById("queue-state")?.textContent).toContain("Superseded");
    document.getElementById("discard-queued")?.click();
    await flushMicrotasks();
    expect(sendMessage.mock.calls.map(([message]) => message)).toContainEqual({ type: "discardQueuedCapture", id: "old" });
    await vi.waitFor(() => expect([...select.options].map((option) => option.value)).toEqual(["", "other"]));
    expect(document.getElementById("status")?.textContent).toBe("Selected capture discarded locally.");
  });

  it("explains that a queued capture may be syncing and a discard cannot recall it", async () => {
    stubRuntimeMessages([
      { ok: true, status: "ready", protocolVersion: EXTENSION_MESSAGE_PROTOCOL_VERSION, paired: true, apiReady: true, discoverySelected: true, queueSize: 1, installationIdSuffix: "00000099" },
      { ok: true, status: "queue_items", items: [{ id: "pending", queuedAt: "2020-01-01T00:00:00Z", originatingUrl: "https://example.test/job", reviewStatus: "pending" }] },
      { ok: true, status: "queue_item", reviewStatus: "pending", item: { originatingUrl: "https://example.test/job", captureMode: "current_page", contentText: "Saved page", futureManualActionRequired: false, captureClient: "browser_extension", extensionVersion: "1" } },
    ]);
    await import("./popup");
    await flushMicrotasks();
    document.getElementById("review-queue")?.click();
    await flushMicrotasks();
    const select = document.getElementById("queue-selection") as HTMLSelectElement;
    expect(select.options[1]?.textContent).toContain("Queued or syncing");
    select.value = "pending";
    select.dispatchEvent(new Event("change"));
    await flushMicrotasks();
    expect(document.getElementById("queue-state")?.textContent).toBe("Queued or syncing.");
    expect(document.getElementById("queue-review")?.textContent).toContain("cannot recall a send in progress");
    expect((document.getElementById("discard-queued") as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([true, false])("refreshes an open queue review after a delayed sync (still queued: %s)", async (stillQueued) => {
    const ready = { ok: true, status: "ready", protocolVersion: EXTENSION_MESSAGE_PROTOCOL_VERSION,
      paired: true, apiReady: true, discoverySelected: true, queueSize: 1, installationIdSuffix: "00000099" };
    const item = { id: "old", queuedAt: "2020-01-01T00:00:00Z", originatingUrl: "https://example.test/job", reviewStatus: "pending" };
    const capture = { originatingUrl: item.originatingUrl, captureMode: "current_page", contentText: "Saved page",
      futureManualActionRequired: false, captureClient: "browser_extension", extensionVersion: "1" };
    let finish!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { finish = resolve; });
    stubRuntimeMessages([
      ready, { ok: true, status: "queue_items", items: [item] },
      { ok: true, status: "queue_item", item: capture, reviewStatus: "pending" }, pending,
      { ...ready, queueSize: stillQueued ? 1 : 0 },
      { ok: true, status: "queue_items", items: stillQueued ? [{ ...item, reviewStatus: "superseded" }] : [] },
      ...(stillQueued ? [{ ok: true, status: "queue_item", item: capture, reviewStatus: "superseded" }] : []),
    ]);
    await import("./popup");
    await flushMicrotasks();
    document.getElementById("review-queue")?.click();
    await flushMicrotasks();
    const select = document.getElementById("queue-selection") as HTMLSelectElement;
    select.value = "old";
    select.dispatchEvent(new Event("change"));
    await flushMicrotasks();
    document.getElementById("retry-queue")?.click();
    await flushMicrotasks();
    expect(document.getElementById("queue-state")?.textContent).toBe("Queued or syncing.");
    finish({ ok: true, status: "queue_flushed", flushed: stillQueued ? 0 : 1, queueSize: stillQueued ? 1 : 0, message: null });
    if (stillQueued) {
      await vi.waitFor(() => expect(document.getElementById("queue-state")?.textContent).toContain("Superseded"));
      expect(select.value).toBe("old");
      expect((document.getElementById("queue-content") as HTMLTextAreaElement).value).toBe("Saved page");
    } else {
      await vi.waitFor(() => expect(select.value).toBe(""));
      expect((document.getElementById("queue-content") as HTMLTextAreaElement).value).toBe("");
      expect((document.getElementById("discard-queued") as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("does not report fake readiness when a new popup is talking to an older background worker", async () => {
    stubRuntimeMessages([
      { ok: true, status: "ready", paired: true, apiReady: true, queueSize: 0 },
    ]);

    await import("./popup");
    await flushMicrotasks();

    expect(document.getElementById("api-state")?.textContent).toBe("Extension update incomplete");
    expect(document.getElementById("api-state")?.textContent).not.toContain("undefined");
    expect(document.getElementById("status")?.textContent).toContain("Reload");
    expect((document.getElementById("token-input") as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById("save-token") as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not enable queue retry against the prior background protocol", async () => {
    stubRuntimeMessages([
      { ok: true, status: "ready", protocolVersion: 3, paired: true, apiReady: true, discoverySelected: true, queueSize: 1, installationIdSuffix: "00000099" },
    ]);
    await import("./popup");
    await flushMicrotasks();
    expect(document.getElementById("api-state")?.textContent).toBe("Extension update incomplete");
    expect((document.getElementById("retry-queue") as HTMLButtonElement).disabled).toBe(true);
  });

  it("lets a paired but unselected installation claim Discovery without copying the token again", async () => {
    const sendMessage = stubRuntimeMessages([
      { ok: true, status: "ready", protocolVersion: EXTENSION_MESSAGE_PROTOCOL_VERSION, paired: true, apiReady: true, discoverySelected: false, queueSize: 0, installationIdSuffix: "00000099" },
      { ok: true, status: "profile_selected" },
      { ok: true, status: "ready", protocolVersion: EXTENSION_MESSAGE_PROTOCOL_VERSION, paired: true, apiReady: true, discoverySelected: true, queueSize: 0, installationIdSuffix: "00000099" },
    ]);

    await import("./popup");
    await flushMicrotasks();

    const selectButton = document.getElementById("select-discovery") as HTMLButtonElement;
    expect(selectButton.hidden).toBe(false);
    expect(document.getElementById("status")?.textContent).toContain("not using this Chrome profile");

    selectButton.click();
    await flushMicrotasks();

    expect(sendMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "getStatus" },
      { type: "selectDiscoveryProfile" },
      { type: "getStatus" },
    ]);
    expect(document.getElementById("status")?.textContent).toBe(
      "This Chrome profile is now selected for Discovery.",
    );
    expect(document.getElementById("api-state")?.textContent).toContain("Discovery connected");
  });
});

function stubRuntimeMessages(responses: unknown[]) {
  const sendMessage = vi.fn(async (_message: unknown): Promise<unknown> => {
    const response = responses.shift();
    if (!response) {
      throw new Error("Unexpected popup message.");
    }
    return response;
  });
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage,
    },
  });
  return sendMessage;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}
