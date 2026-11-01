import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type BrowserContext, type Page } from "@playwright/test";
import { expect, it } from "vitest";

import { launchExtensionContext } from "./chromium-extension-test-context.js";

it("retains an in-flight capture through service-worker restart, pairing and explicit sync", async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-queue-e2e-"));
  let context: BrowserContext | null = null;
  try {
    context = await launchExtensionContext(userDataDir);
    context.setDefaultTimeout(10_000);
    let mode: "hold" | "offline" | "online" = "hold";
    const acknowledged: string[] = [];
    let heldCaptureId = "";
    let started!: () => void;
    let release!: () => void;
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    const releaseRequest = new Promise<void>((resolve) => { release = resolve; });
    await context.route("http://127.0.0.1:8766/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const headers = {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization,content-type,x-jobctrl-extension-installation,x-jobctrl-extension-version",
        "access-control-allow-methods": "GET,POST,OPTIONS",
      };
      if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
      if (url.pathname === "/synthetic-capture") {
        await route.fulfill({ status: 200, contentType: "text/html", body: "<title>Synthetic role</title><main>Synthetic job description</main>" });
        return;
      }
      if (url.pathname === "/v1/extension/captures") {
        const body = request.postDataJSON() as { captureId: string; originatingUrl: string; captureMode: string; futureManualActionRequired: boolean };
        if (mode === "hold") {
          heldCaptureId = body.captureId;
          started();
          await releaseRequest;
          await route.fulfill({ status: 503, headers, body: "{}" }).catch(() => undefined);
          return;
        }
        if (mode === "offline") { await route.fulfill({ status: 503, headers, body: "{}" }); return; }
        acknowledged.push(body.captureId);
        await route.fulfill({ status: 200, headers, contentType: "application/json", body: JSON.stringify({
          ok: true,
          itemId: `extension:${createHash("sha256").update(body.captureId).digest("hex").slice(0, 32)}`,
          jobKey: null,
          importedAt: "2026-07-05T10:00:00Z",
          provenance: { sourceKind: "user_mediated_capture", originatingUrl: body.originatingUrl, captureMode: body.captureMode, futureManualActionRequired: body.futureManualActionRequired },
        }) });
        return;
      }
      if (url.pathname === "/v1/extension/discovery/tasks/next") {
        await route.fulfill({ status: 200, headers, contentType: "application/json", body: '{"ok":true,"status":"idle"}' });
        return;
      }
      await route.fulfill({ status: 200, headers, contentType: "application/json", body: '{"ok":true}' });
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 10_000 });
    const controller = await context.newPage();
    await controller.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    expect(await send(controller, { type: "saveToken", token: "synthetic-token" })).toMatchObject({ ok: true, status: "token_saved" });
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:8766/synthetic-capture");
    await page.bringToFront();
    const interrupted = send(controller, { type: "captureCurrentTab" }).catch(() => null);
    await bounded(requestStarted, "first capture request");
    const pending = await worker.evaluate(async () => (await chrome.storage.local.get("jobctrlCaptureQueue"))["jobctrlCaptureQueue"]);
    expect(pending).toMatchObject([{ capture: { captureId: heldCaptureId } }]);
    const session = await context.newCDPSession(controller);
    const lifecycle: Array<{ versionId: string; runningStatus: string }> = [];
    const waiters: Array<() => void> = [];
    session.on("ServiceWorker.workerVersionUpdated", (event) => {
      for (const version of event.versions) {
        if (version.scriptURL === worker.url()) lifecycle.push({ versionId: version.versionId, runningStatus: version.runningStatus });
      }
      for (const resolve of waiters.splice(0)) resolve();
    });
    const waitForState = async (status: string, after: number, versionId?: string): Promise<number> => {
      while (true) {
        const index = lifecycle.findIndex((event, position) => position > after && event.runningStatus === status && (!versionId || event.versionId === versionId));
        if (index >= 0) return index;
        await bounded(new Promise<void>((resolve) => waiters.push(resolve)), `worker state ${status}`);
      }
    };
    await session.send("ServiceWorker.enable");
    const initial = await waitForState("running", -1);
    const versionId = lifecycle[initial]!.versionId;
    await session.send("ServiceWorker.stopWorker", { versionId });
    const stopped = await waitForState("stopped", initial, versionId);
    mode = "offline";
    release();
    await bounded(interrupted, "interrupted capture response");
    await waitForState("running", stopped, versionId);
    expect(await send(controller, { type: "getStatus" })).toMatchObject({ ok: true, queueSize: 1 });
    await session.detach();

    await page.bringToFront();
    expect(await send(controller, { type: "captureCurrentTab" })).toMatchObject({ ok: true, status: "queued", queueSize: 2 });
    expect(await send(controller, { type: "saveToken", token: "synthetic-token" })).toMatchObject({ ok: true, status: "token_saved" });
    expect(await send(controller, { type: "getStatus" })).toMatchObject({ ok: true, queueSize: 2 });
    mode = "online";
    await controller.bringToFront();
    await controller.reload();
    await controller.waitForFunction(() => !(document.querySelector("#retry-queue") as HTMLButtonElement).disabled);
    await controller.click("#retry-queue");
    await controller.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("2 capture(s) synced. 0 still queued."));
    expect(acknowledged).toContain(heldCaptureId);
    await page.bringToFront();
    expect(await send(controller, { type: "captureCurrentTab" })).toMatchObject({ ok: true, status: "captured", queueSize: 0 });
    expect(acknowledged).toHaveLength(3);
    expect(new Set(acknowledged).size).toBe(3);
    expect(await send(controller, { type: "getStatus" })).toMatchObject({ ok: true, queueSize: 0 });
  } finally {
    await context?.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}, 60_000);

it("retains a pending response and retries with a newly paired token after the old request settles", async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-queue-repair-e2e-"));
  let context: BrowserContext | null = null;
  let releaseOld: () => void = () => undefined;
  let releaseNew: () => void = () => undefined;
  try {
    context = await launchExtensionContext(userDataDir);
    context.setDefaultTimeout(10_000);
    const sent: Array<{ token: string | undefined; captureId: string }> = [];
    let oldStarted!: () => void;
    let newStarted!: () => void;
    const oldRequest = new Promise<void>((resolve) => { oldStarted = resolve; });
    const newRequest = new Promise<void>((resolve) => { newStarted = resolve; });
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const newGate = new Promise<void>((resolve) => { releaseNew = resolve; });
    await context.route("http://127.0.0.1:8766/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const headers = {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization,content-type,x-jobctrl-extension-installation,x-jobctrl-extension-version",
        "access-control-allow-methods": "GET,POST,OPTIONS",
      };
      if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
      if (url.pathname === "/synthetic-capture") {
        await route.fulfill({ status: 200, contentType: "text/html", body: "<title>Synthetic role</title><main>Synthetic posting</main>" });
        return;
      }
      if (url.pathname === "/v1/extension/captures") {
        const body = request.postDataJSON() as { captureId: string; originatingUrl: string; captureMode: string; futureManualActionRequired: boolean };
        const token = request.headers().authorization;
        sent.push({ token, captureId: body.captureId });
        const acknowledgement = {
          ok: true,
          itemId: `extension:${createHash("sha256").update(body.captureId).digest("hex").slice(0, 32)}`,
          jobKey: null,
          importedAt: "2026-07-05T10:00:00Z",
          provenance: { sourceKind: "user_mediated_capture", originatingUrl: body.originatingUrl, captureMode: body.captureMode, futureManualActionRequired: body.futureManualActionRequired },
        };
        if (token === "Bearer old-synthetic-token") {
          oldStarted();
          await oldGate;
          await route.fulfill({ status: 200, headers, contentType: "application/json", body: JSON.stringify({ ...acknowledgement, status: "pending" }) });
          return;
        }
        newStarted();
        await newGate;
        await route.fulfill({ status: 200, headers, contentType: "application/json", body: JSON.stringify(acknowledgement) });
        return;
      }
      if (url.pathname === "/v1/extension/discovery/tasks/next") {
        await route.fulfill({ status: 200, headers, contentType: "application/json", body: '{"ok":true,"status":"idle"}' });
        return;
      }
      await route.fulfill({ status: 200, headers, contentType: "application/json", body: '{"ok":true}' });
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 10_000 });
    const controller = await context.newPage();
    await controller.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    expect(await send(controller, { type: "saveToken", token: "old-synthetic-token" })).toMatchObject({ ok: true, status: "token_saved" });
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:8766/synthetic-capture");
    await page.bringToFront();
    const first = send(controller, { type: "captureCurrentTab" });
    await bounded(oldRequest, "old-token request");
    expect(await send(controller, { type: "saveToken", token: "new-synthetic-token" })).toMatchObject({ ok: true, status: "token_saved" });
    const retry = send(controller, { type: "retryQueue" });
    const second = send(controller, { type: "captureCurrentTab" });
    await controller.waitForFunction(async () => {
      const value = (await chrome.storage.local.get("jobctrlCaptureQueue"))["jobctrlCaptureQueue"];
      return Array.isArray(value) && value.length === 2;
    });
    expect(sent).toHaveLength(1);
    releaseOld();
    await bounded(newRequest, "new-token retry");
    expect(await first).toMatchObject({ ok: true, status: "queued", queueSize: 2 });
    expect(await send(controller, { type: "getStatus" })).toMatchObject({ ok: true, queueSize: 2 });
    releaseNew();
    expect(await retry).toMatchObject({ ok: true, status: "queue_flushed", flushed: 2, queueSize: 0, message: null });
    expect(await second).toMatchObject({ ok: true, status: "captured", queueSize: 0 });
    expect(sent.map((item) => item.token)).toEqual(["Bearer old-synthetic-token", "Bearer new-synthetic-token", "Bearer new-synthetic-token"]);
    expect(sent[1]?.captureId).toBe(sent[0]?.captureId);
    expect(sent[2]?.captureId).not.toBe(sent[0]?.captureId);
    expect(await send(controller, { type: "getStatus" })).toMatchObject({ ok: true, queueSize: 0 });
  } finally {
    releaseOld();
    releaseNew();
    await context?.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}, 60_000);

async function send(page: Page, payload: unknown): Promise<unknown> {
  return bounded(page.evaluate((message) => new Promise((resolve) => {
    (globalThis as unknown as { chrome: { runtime: { sendMessage(input: unknown, callback: (response: unknown) => void): void } } }).chrome.runtime.sendMessage(message, resolve);
  }), payload), `extension message ${String((payload as { type?: unknown }).type)}`);
}

async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
