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
        <button id="select-discovery" type="button" hidden>Use this Chrome profile for Discovery</button>
        <button id="capture" type="button">Save job</button>
        <button id="autofill" type="button">Review autofill</button>
        <button id="clear-queue" type="button">Clear queue</button>
        <p id="status" role="status"></p>
      </main>
    `;
  });

  it("preserves successful autofill feedback after refreshing readiness state", async () => {
    const sendMessage = stubRuntimeMessages([
      { ok: true, status: "ready", protocolVersion: 1, paired: true, apiReady: true, discoverySelected: true, queueSize: 0, installationIdSuffix: "00000099" },
      { ok: true, status: "review_opened", suggestions: 2, missing: 1 },
      { ok: true, status: "ready", protocolVersion: 1, paired: true, apiReady: true, discoverySelected: true, queueSize: 0, installationIdSuffix: "00000099" },
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
      { ok: true, status: "ready", protocolVersion: 1, paired: true, apiReady: true, discoverySelected: true, queueSize: 0, installationIdSuffix: "00000099" },
      { ok: true, status: "captured", jobKey: "job-123", queueSize: 0 },
      { ok: true, status: "ready", protocolVersion: 1, paired: true, apiReady: true, discoverySelected: true, queueSize: 0, installationIdSuffix: "00000099" },
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

  it("lets a paired but unselected installation claim Discovery without copying the token again", async () => {
    const sendMessage = stubRuntimeMessages([
      { ok: true, status: "ready", protocolVersion: 1, paired: true, apiReady: true, discoverySelected: false, queueSize: 0, installationIdSuffix: "00000099" },
      { ok: true, status: "profile_selected" },
      { ok: true, status: "ready", protocolVersion: 1, paired: true, apiReady: true, discoverySelected: true, queueSize: 0, installationIdSuffix: "00000099" },
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
