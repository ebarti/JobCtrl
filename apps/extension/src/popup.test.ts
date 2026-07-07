// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

describe("extension popup", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = `
      <main>
        <span id="api-state">Checking</span>
        <input id="token-input" />
        <button id="save-token" type="button">Save</button>
        <button id="capture" type="button">Save job</button>
        <button id="autofill" type="button">Review autofill</button>
        <button id="clear-queue" type="button">Clear queue</button>
        <p id="status" role="status"></p>
      </main>
    `;
  });

  it("preserves successful autofill feedback after refreshing readiness state", async () => {
    const sendMessage = stubRuntimeMessages([
      { ok: true, status: "ready", paired: true, apiReady: true, queueSize: 0 },
      { ok: true, status: "review_opened", suggestions: 2, missing: 1 },
      { ok: true, status: "ready", paired: true, apiReady: true, queueSize: 0 },
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
  });

  it("preserves successful capture feedback after refreshing readiness state", async () => {
    const sendMessage = stubRuntimeMessages([
      { ok: true, status: "ready", paired: true, apiReady: true, queueSize: 0 },
      { ok: true, status: "captured", jobKey: "job-123", queueSize: 0 },
      { ok: true, status: "ready", paired: true, apiReady: true, queueSize: 0 },
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
    expect(document.getElementById("status")?.textContent).toBe("Saved to JobCtl: job-123");
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
