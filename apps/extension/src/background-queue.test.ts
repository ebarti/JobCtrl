import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BrowserMessageListener, BrowserStorageArea } from "./browser";
import { CAPTURE_QUEUE_STORAGE_KEY, MAX_CAPTURE_QUEUE_SIZE } from "./queue";

function capture(name: string, captureId?: string) {
  return {
    ...(captureId ? { captureId } : {}),
    originatingUrl: `https://example.com/jobs/${name}`,
    capturedUrl: `https://example.com/jobs/${name}`,
    captureMode: "current_page" as const,
    contentText: `Synthetic ${name}`,
    futureManualActionRequired: false,
    captureClient: "browser_extension" as const,
    extensionVersion: "0.3.0",
  };
}
function entry(name: string, captureId?: string) {
  return { id: `queued-${name}`, queuedAt: "2020-01-01T00:00:00.000Z", capture: capture(name, captureId) };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function acknowledgement(body: ReturnType<typeof capture>, captureId = body.captureId!) {
  return {
    ok: true,
    itemId: `extension:${createHash("sha256").update(captureId).digest("hex").slice(0, 32)}`,
    jobKey: null,
    importedAt: "2026-07-05T10:00:00Z",
    provenance: {
      sourceKind: "user_mediated_capture", originatingUrl: body.originatingUrl,
      captureMode: body.captureMode, futureManualActionRequired: body.futureManualActionRequired,
    },
  };
}

async function harness(initial: unknown[] = []) {
  const values = new Map<string, unknown>([
    [CAPTURE_QUEUE_STORAGE_KEY, structuredClone(initial)],
    ["jobctrlExtensionCapabilityToken", "synthetic-token"],
    ["jobctrlDiscoveryInstallationId", "11111111-1111-4111-8111-111111111111"],
  ]);
  let listener: BrowserMessageListener;
  let sequence = 0;
  let beforeGet: (() => Promise<void>) | undefined;
  let failSet = false;
  let failRemove = false;
  let failGet = false;
  let sendCapture: (body: ReturnType<typeof capture>, authorization: string | null) => Promise<Response> = async () => { throw new Error("synthetic offline"); };
  const storage: BrowserStorageArea = {
    async get(key) {
      if (failGet && key === CAPTURE_QUEUE_STORAGE_KEY) throw new Error("synthetic read failure");
      const value = structuredClone(values.get(String(key)));
      if (key === CAPTURE_QUEUE_STORAGE_KEY) await beforeGet?.();
      return { [String(key)]: value };
    },
    async set(items) {
      if (failSet && CAPTURE_QUEUE_STORAGE_KEY in items) throw new Error("synthetic write failure");
      for (const [key, value] of Object.entries(items)) values.set(key, structuredClone(value));
    },
    async remove(key) {
      if (failRemove) throw new Error("synthetic clear failure");
      for (const item of Array.isArray(key) ? key : [key]) values.delete(item);
    },
  };
  vi.stubGlobal("chrome", {
    storage: { local: storage },
    runtime: { getManifest: () => ({ version: "0.3.0" }), onMessage: { addListener(value: BrowserMessageListener) { listener = value; } } },
    tabs: { async query() { const id = ++sequence; return [{ id, url: `https://example.com/jobs/page-${id}` }]; } },
    scripting: { async executeScript({ target }: { target: { tabId: number } }) { return [{ result: { title: "Synthetic", text: `Synthetic page-${target.tabId}` } }]; } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/extension/discovery/claim")) {
      const body = JSON.parse(String(init?.body)) as { replace: boolean };
      return new Response("{}", { status: body.replace ? 200 : 403 });
    }
    if (url.endsWith("/v1/extension/captures")) {
      return sendCapture(JSON.parse(String(init?.body)) as ReturnType<typeof capture>, new Headers(init?.headers).get("authorization"));
    }
    if (url.endsWith("/v1/health")) return new Response("{}", { status: 200 });
    throw new Error(`Unexpected synthetic endpoint: ${url}`);
  }));
  const restart = async () => { vi.resetModules(); await import("./background"); };
  await restart();
  return {
    storage,
    queue: () => structuredClone(values.get(CAPTURE_QUEUE_STORAGE_KEY)),
    gateGet: (gate?: () => Promise<void>) => { beforeGet = gate; },
    failSet: (fail: boolean) => { failSet = fail; },
    failRemove: (fail: boolean) => { failRemove = fail; },
    failGet: (fail: boolean) => { failGet = fail; },
    sendCapture: (fn: typeof sendCapture) => { sendCapture = fn; },
    restart,
    send: (message: unknown) => new Promise<unknown>((resolve) => { listener(message, {}, resolve); }),
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("background capture ownership", () => {
  it("reviews and discards only the superseded capture while another queued entry remains", async () => {
    const fixture = await harness([entry("old", "old-id"), entry("new", "new-id"), entry("pending", "pending-id")]);
    fixture.sendCapture(async (body) => {
      if (body.captureId === "old-id") return new Response(JSON.stringify({ ok: false, error: "extension_capture_superseded" }), { status: 409 });
      if (body.captureId === "new-id") return json(acknowledgement(body));
      throw new Error("synthetic offline");
    });
    expect(await fixture.send({ type: "retryQueue" })).toMatchObject({ ok: true, status: "queue_flushed", flushed: 1, queueSize: 2 });
    await fixture.restart();
    expect(await fixture.send({ type: "reviewQueue" })).toMatchObject({ ok: true, status: "queue_items", items: [
      { id: "queued-old", originatingUrl: "https://example.com/jobs/old", reviewStatus: "superseded" },
      { id: "queued-pending", originatingUrl: "https://example.com/jobs/pending", reviewStatus: "pending" },
    ] });
    expect(await fixture.send({ type: "getQueuedCapture", id: "queued-old" })).toMatchObject({ ok: true, status: "queue_item",
      reviewStatus: "superseded", item: { contentText: "Synthetic old", captureId: "old-id" } });
    expect(await fixture.send({ type: "discardQueuedCapture", id: "queued-old" }))
      .toMatchObject({ ok: true, status: "queue_item_discarded", removed: true });
    expect(fixture.queue()).toEqual([entry("pending", "pending-id")]);
    expect(await fixture.send({ type: "discardQueuedCapture", id: "queued-old" }))
      .toMatchObject({ ok: true, status: "queue_item_discarded", removed: false });
  });

  it("frees one slot in a full queue only after the selected capture is discarded", async () => {
    const pending = Array.from({ length: MAX_CAPTURE_QUEUE_SIZE }, (_, index) => ({ ...entry(`item-${index}`, `id-${index}`), reviewStatus: "superseded" }));
    const fixture = await harness(pending);
    expect(await fixture.send({ type: "captureCurrentTab" })).toMatchObject({ ok: false, message: expect.stringContaining("full") });
    expect(fixture.queue()).toEqual(pending);
    expect(await fixture.send({ type: "discardQueuedCapture", id: "queued-item-0" }))
      .toMatchObject({ ok: true, removed: true });
    expect(await fixture.send({ type: "captureCurrentTab" })).toMatchObject({ ok: true, status: "queued", queueSize: MAX_CAPTURE_QUEUE_SIZE });
    const remaining = fixture.queue() as Array<{ id: string; capture: { contentText: string } }>;
    expect(remaining).toHaveLength(MAX_CAPTURE_QUEUE_SIZE);
    expect(remaining.some((item) => item.id === "queued-item-0")).toBe(false);
    expect(remaining.some((item) => item.capture.contentText === "Synthetic page-2")).toBe(true);
    for (const item of pending.slice(1)) expect(remaining).toContainEqual(item);
  });

  it("keeps other entries when one is discarded during an in-flight send", async () => {
    const fixture = await harness([entry("old", "old-id"), entry("other", "other-id")]);
    const started = deferred();
    const release = deferred();
    fixture.sendCapture(async (body) => {
      if (body.captureId === "old-id") { started.resolve(); await release.promise; return json(acknowledgement(body)); }
      throw new Error("synthetic offline");
    });
    const flushing = fixture.send({ type: "retryQueue" });
    await started.promise;
    expect(await fixture.send({ type: "getQueuedCapture", id: "queued-old" }))
      .toMatchObject({ ok: true, reviewStatus: "pending" });
    expect(await fixture.send({ type: "discardQueuedCapture", id: "queued-old" }))
      .toMatchObject({ ok: true, removed: true });
    expect(fixture.queue()).toEqual([entry("other", "other-id")]);
    release.resolve();
    expect(await flushing).toMatchObject({ ok: true, status: "queue_flushed", flushed: 1, queueSize: 1 });
    expect(fixture.queue()).toEqual([entry("other", "other-id")]);
  });
  it("preserves pending captures when pairing and across service-worker restart, until explicit clear", async () => {
    const pending = [entry("old")];
    const fixture = await harness(pending);
    expect(await fixture.send({ type: "saveToken", token: "new-synthetic-token" })).toMatchObject({ ok: true, status: "token_saved" });
    expect(fixture.queue()).toEqual(pending);
    await fixture.restart();
    expect(await fixture.send({ type: "getStatus" })).toMatchObject({ ok: true, queueSize: 1 });
    expect(fixture.queue()).toEqual(pending);
    expect(await fixture.send({ type: "clearQueue" })).toMatchObject({ ok: true, queueSize: 0 });
    expect(fixture.queue()).toBeUndefined();
  });

  it("keeps simultaneous offline captures even when the first read is delayed", async () => {
    const fixture = await harness();
    const started = deferred(); const release = deferred(); let reads = 0;
    fixture.gateGet(async () => { if (++reads === 1) { started.resolve(); await release.promise; } });
    const first = fixture.send({ type: "captureCurrentTab" });
    await started.promise;
    const second = fixture.send({ type: "captureCurrentTab" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    release.resolve();
    expect(await first).toMatchObject({ ok: true, status: "queued" });
    expect(await second).toMatchObject({ ok: true, status: "queued" });
    expect(fixture.queue()).toMatchObject([
      { capture: { contentText: "Synthetic page-1" } },
      { capture: { contentText: "Synthetic page-2" } },
    ]);
  });

  it("persists the current capture before its first network request", async () => {
    const fixture = await harness();
    const started = deferred(); const release = deferred();
    fixture.sendCapture(async (body) => {
      expect(fixture.queue()).toMatchObject([{ capture: { captureId: body.captureId, contentText: "Synthetic page-1" } }]);
      started.resolve();
      await release.promise;
      return json(acknowledgement(body));
    });
    const saving = fixture.send({ type: "captureCurrentTab" });
    await started.promise;
    expect(fixture.queue()).toHaveLength(1);
    release.resolve();
    expect(await saving).toMatchObject({ ok: true, status: "captured", queueSize: 0 });
    expect(fixture.queue()).toEqual([]);
  });

  it("preserves an enqueue and pairing while an older capture flush is in flight", async () => {
    const fixture = await harness([entry("old", "old-stable-id")]);
    const started = deferred(); const release = deferred();
    fixture.sendCapture(async (body) => {
      if (body.contentText === "Synthetic old") { started.resolve(); await release.promise; return json(acknowledgement(body)); }
      if (body.contentText === "Synthetic page-2") throw new Error("synthetic offline");
      return json(acknowledgement(body));
    });
    const first = fixture.send({ type: "captureCurrentTab" });
    await started.promise;
    const second = fixture.send({ type: "captureCurrentTab" });
    await vi.waitFor(() => expect(fixture.queue()).toHaveLength(3));
    expect(await fixture.send({ type: "saveToken", token: "new-synthetic-token" })).toMatchObject({ ok: true, status: "token_saved" });
    release.resolve();
    expect(await first).toMatchObject({ ok: true, status: "captured", queueSize: 1 });
    expect(await second).toMatchObject({ ok: true, status: "queued", queueSize: 1 });
    expect(fixture.queue()).toMatchObject([{ capture: { contentText: "Synthetic page-2" } }]);
  });

  it("uses a newly paired token for an explicit retry while the old request is in flight", async () => {
    const fixture = await harness([entry("old", "old-stable-id")]);
    const started = deferred(); const release = deferred();
    const sent: Array<{ token: string | null; captureId: string | undefined }> = [];
    fixture.sendCapture(async (body, token) => {
      sent.push({ token, captureId: body.captureId });
      if (token === "Bearer synthetic-token") {
        started.resolve();
        await release.promise;
        return new Response("{}", { status: 401 });
      }
      return json(acknowledgement(body));
    });
    const first = fixture.send({ type: "retryQueue" });
    await started.promise;
    expect(await fixture.send({ type: "saveToken", token: "new-synthetic-token" })).toMatchObject({ ok: true, status: "token_saved" });
    const retry = fixture.send({ type: "retryQueue" });
    const capturePage = fixture.send({ type: "captureCurrentTab" });
    await vi.waitFor(() => expect(fixture.queue()).toHaveLength(2));
    release.resolve();
    expect(await first).toMatchObject({ ok: true, status: "queue_flushed", flushed: 0, message: expect.stringContaining("rejected") });
    expect(await retry).toMatchObject({ ok: true, status: "queue_flushed", flushed: 2, queueSize: 0, message: null });
    expect(await capturePage).toMatchObject({ ok: true, status: "captured", queueSize: 0 });
    expect(sent.map((request) => request.token)).toEqual([
      "Bearer synthetic-token", "Bearer new-synthetic-token", "Bearer new-synthetic-token",
    ]);
    expect(sent[1]?.captureId).toBe(sent[0]?.captureId);
    expect(fixture.queue()).toEqual([]);
  });

  it("retains a capture when a pending response resembles an import acknowledgement", async () => {
    const fixture = await harness([entry("old", "old-stable-id")]);
    fixture.sendCapture(async (body) => json({ ...acknowledgement(body), status: "pending" }));
    expect(await fixture.send({ type: "retryQueue" })).toMatchObject({ ok: true, status: "queue_flushed", flushed: 0, queueSize: 1 });
    expect(fixture.queue()).toEqual([entry("old", "old-stable-id")]);
    fixture.sendCapture(async (body) => json(acknowledgement(body)));
    expect(await fixture.send({ type: "retryQueue" })).toMatchObject({ ok: true, status: "queue_flushed", flushed: 1, queueSize: 0 });
  });

  it("retains a legacy capture on foreign acknowledgement and reuses its saved ID after restart", async () => {
    const fixture = await harness([entry("old")]);
    const sentIds: string[] = [];
    fixture.sendCapture(async (body) => {
      if (body.contentText === "Synthetic old") { sentIds.push(body.captureId!); return json(acknowledgement(body, "foreign-id")); }
      return json(acknowledgement(body));
    });
    expect(await fixture.send({ type: "retryQueue" })).toMatchObject({ ok: true, status: "queue_flushed", flushed: 0, queueSize: 1 });
    expect(fixture.queue()).toMatchObject([{ capture: { captureId: sentIds[0] } }]);
    await fixture.restart();
    expect(await fixture.send({ type: "retryQueue" })).toMatchObject({ ok: true, status: "queue_flushed", flushed: 0, queueSize: 1 });
    expect(sentIds).toHaveLength(2);
    expect(sentIds[1]).toBe(sentIds[0]);
    expect(fixture.queue()).toMatchObject([{ capture: { contentText: "Synthetic old", captureId: sentIds[0] } }]);
  });

  it("keeps the current page queued when removing an acknowledged item fails", async () => {
    const fixture = await harness([entry("old", "old-stable-id")]);
    fixture.sendCapture(async (body) => { fixture.failSet(true); return json(acknowledgement(body)); });
    expect(await fixture.send({ type: "captureCurrentTab" })).toMatchObject({
      ok: false, error: "capture_queue_unavailable", message: expect.stringContaining("capture was queued locally"),
    });
    expect(fixture.queue()).toMatchObject([entry("old", "old-stable-id"), { capture: { contentText: "Synthetic page-1" } }]);
  });

  it("does not falsely clear or overwrite pending captures on storage failure or at capacity", async () => {
    const pending = Array.from({ length: MAX_CAPTURE_QUEUE_SIZE }, (_, index) => entry(String(index)));
    const fixture = await harness(pending);
    expect(await fixture.send({ type: "captureCurrentTab" })).toMatchObject({ ok: false, message: expect.stringContaining("page was not saved") });
    expect(fixture.queue()).toEqual(pending);
    fixture.failRemove(true);
    expect(await fixture.send({ type: "clearQueue" })).toMatchObject({ ok: false });
    fixture.failRemove(false);
    expect(fixture.queue()).toEqual(pending);
    fixture.failGet(true);
    expect(await fixture.send({ type: "getStatus" })).toMatchObject({ ok: false, error: "capture_queue_unavailable" });
    fixture.failGet(false);
    expect(await fixture.send({ type: "getStatus" })).toMatchObject({ ok: true, queueSize: MAX_CAPTURE_QUEUE_SIZE });
    expect(fixture.queue()).toEqual(pending);
    fixture.sendCapture(async (body) => json(acknowledgement(body)));
    expect(await fixture.send({ type: "retryQueue" })).toMatchObject({ ok: true, status: "queue_flushed", flushed: MAX_CAPTURE_QUEUE_SIZE, queueSize: 0 });
    expect(await fixture.send({ type: "captureCurrentTab" })).toMatchObject({ ok: true, status: "captured", queueSize: 0 });
  });
});
