import { describe, expect, it, vi } from "vitest";
import type { ExtensionCaptureIngestRequest } from "@jobctrl/contracts";

import type { BrowserStorageArea } from "./browser";
import { LocalApiError, postExtensionCapture } from "./local-api";
import {
  CAPTURE_QUEUE_STORAGE_KEY,
  MAX_CAPTURE_QUEUE_SIZE,
  clearCaptureQueue,
  enqueueCapture,
  flushCaptureQueue,
  loadCaptureQueue,
} from "./queue";

function capture(name: string) {
  return {
    originatingUrl: `https://example.com/jobs/${name}`,
    captureMode: "current_page" as const,
    capturedUrl: `https://example.com/jobs/${name}`,
    contentText: `Synthetic ${name}`,
    futureManualActionRequired: false,
    captureClient: "browser_extension" as const,
    extensionVersion: "0.3.0",
  };
}

function acknowledged(input: ExtensionCaptureIngestRequest) {
  return {
    ok: true as const,
    itemId: "synthetic-item",
    jobKey: null,
    importedAt: "2026-07-05T00:00:00Z",
    provenance: {
      sourceKind: "user_mediated_capture" as const,
      originatingUrl: input.originatingUrl,
      captureMode: input.captureMode,
      futureManualActionRequired: input.futureManualActionRequired,
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function memoryStorage(initial: unknown = undefined) {
  const store = new Map<string, unknown>();
  if (initial !== undefined) store.set(CAPTURE_QUEUE_STORAGE_KEY, structuredClone(initial));
  let beforeGet: (() => Promise<void>) | undefined;
  let failSet = false;
  let failRemove = false;
  let failGet = false;
  const storage: BrowserStorageArea = {
    async get(key) {
      if (failGet) throw new Error("synthetic read failure");
      const value = structuredClone(store.get(String(key)));
      await beforeGet?.();
      return { [String(key)]: value };
    },
    async set(items) {
      if (failSet) throw new Error("synthetic write failure");
      for (const [key, value] of Object.entries(items)) store.set(key, structuredClone(value));
    },
    async remove(key) {
      if (failRemove) throw new Error("synthetic clear failure");
      for (const item of Array.isArray(key) ? key : [key]) store.delete(item);
    },
  };
  return {
    storage,
    raw: () => structuredClone(store.get(CAPTURE_QUEUE_STORAGE_KEY)),
    gateGet: (gate?: () => Promise<void>) => { beforeGet = gate; },
    failSet: (fail: boolean) => { failSet = fail; },
    failRemove: (fail: boolean) => { failRemove = fail; },
    failGet: (fail: boolean) => { failGet = fail; },
  };
}

describe("extension capture queue", () => {
  it("retains old captures and refuses new ones at capacity", async () => {
    const { storage } = memoryStorage();
    for (let index = 0; index < MAX_CAPTURE_QUEUE_SIZE; index += 1) {
      await enqueueCapture(storage, capture(String(index)), new Date("2020-01-01T00:00:00Z"));
    }
    const before = await loadCaptureQueue(storage);
    await expect(enqueueCapture(storage, capture("overflow"))).rejects.toThrow(/queue is full.*page was not saved/i);
    expect(await loadCaptureQueue(storage)).toEqual(before);
    expect(before).toHaveLength(MAX_CAPTURE_QUEUE_SIZE);
  });

  it("serializes concurrent enqueues without overwriting either capture", async () => {
    const fixture = memoryStorage();
    const started = deferred();
    const release = deferred();
    let reads = 0;
    fixture.gateGet(async () => { if (++reads === 1) { started.resolve(); await release.promise; } });
    const first = enqueueCapture(fixture.storage, capture("one"));
    await started.promise;
    const second = enqueueCapture(fixture.storage, capture("two"));
    release.resolve();
    await Promise.all([first, second]);
    fixture.gateGet();
    expect((await loadCaptureQueue(fixture.storage)).map((item) => item.capture.contentText).sort())
      .toEqual(["Synthetic one", "Synthetic two"]);
  });

  it("removes only acknowledged entries and preserves an enqueue during a flush", async () => {
    const { storage } = memoryStorage();
    await enqueueCapture(storage, capture("one"));
    await enqueueCapture(storage, capture("two"));
    const started = deferred();
    const release = deferred();
    const send = vi.fn(async (_token: string, item: ExtensionCaptureIngestRequest) => {
      if (item.contentText === "Synthetic one") { started.resolve(); await release.promise; return acknowledged(item); }
      throw new Error("synthetic offline");
    });
    const flushing = flushCaptureQueue(storage, "token", send);
    await started.promise;
    await enqueueCapture(storage, capture("three"));
    release.resolve();
    expect(await flushing).toMatchObject({ flushed: 1, remaining: 2, failure: "Local JobCtrl API is unavailable." });
    expect((await loadCaptureQueue(storage)).map((item) => item.capture.contentText))
      .toEqual(["Synthetic two", "Synthetic three"]);
  });

  it("shares concurrent flushes and sends an entry only once", async () => {
    const { storage } = memoryStorage();
    await enqueueCapture(storage, capture("one"));
    const started = deferred();
    const release = deferred();
    const send = vi.fn(async (_token: string, item: ExtensionCaptureIngestRequest) => {
      started.resolve(); await release.promise; return acknowledged(item);
    });
    const first = flushCaptureQueue(storage, "token", send);
    await started.promise;
    const second = flushCaptureQueue(storage, "token", send);
    release.resolve();
    expect(await Promise.all([first, second])).toMatchObject([{ flushed: 1, remaining: 0 }, { flushed: 1, remaining: 0 }]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries with a new token after the old flush, including captures enqueued during it", async () => {
    const { storage } = memoryStorage();
    const old = await enqueueCapture(storage, capture("one"));
    const started = deferred();
    const release = deferred();
    const seen: Array<{ token: string; captureId: string | undefined }> = [];
    const send = vi.fn(async (token: string, item: ExtensionCaptureIngestRequest) => {
      seen.push({ token, captureId: item.captureId });
      if (token === "old") {
        started.resolve();
        await release.promise;
        throw new LocalApiError("synthetic rejected token", 401);
      }
      return acknowledged(item);
    });
    const first = flushCaptureQueue(storage, "old", send);
    await started.promise;
    const second = flushCaptureQueue(storage, "new", send);
    const coalesced = flushCaptureQueue(storage, "new", send);
    const added = await enqueueCapture(storage, capture("two"));
    expect(seen).toEqual([{ token: "old", captureId: old.item.capture.captureId }]);
    release.resolve();
    expect(await first).toMatchObject({ flushed: 0, remaining: 2, failure: expect.stringContaining("rejected") });
    expect(await Promise.all([second, coalesced])).toMatchObject([
      { flushed: 2, remaining: 0, failure: null }, { flushed: 2, remaining: 0, failure: null },
    ]);
    expect(seen).toEqual([
      { token: "old", captureId: old.item.capture.captureId },
      { token: "new", captureId: old.item.capture.captureId },
      { token: "new", captureId: added.item.capture.captureId },
    ]);
    expect(await loadCaptureQueue(storage)).toEqual([]);
  });

  it("retains a capture after a stalled response body and permits a later flush", async () => {
    const { storage } = memoryStorage();
    const queued = await enqueueCapture(storage, capture("one"));
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const fetchImpl: typeof fetch = async () => new Response(new ReadableStream({ start(controller) {
      stream = controller;
      controller.enqueue(new TextEncoder().encode("{"));
    } }), { status: 200 });
    try {
      const result = await flushCaptureQueue(storage, "token", (token, item) =>
        postExtensionCapture(token, item, { fetchImpl, timeoutMs: 30 }));
      expect(result).toMatchObject({ flushed: 0, remaining: 1, failure: expect.stringMatching(/timed out/i) });
      expect(await loadCaptureQueue(storage)).toEqual([queued.item]);
      const retried = vi.fn(async (_token: string, item: ExtensionCaptureIngestRequest) => acknowledged(item));
      expect(await flushCaptureQueue(storage, "token", retried)).toMatchObject({ flushed: 1, remaining: 0 });
      expect(retried.mock.calls[0]?.[1].captureId).toBe(queued.item.capture.captureId);
    } finally {
      stream.error(new Error("synthetic stream closed"));
    }
  }, 1_000);

  it("retains a superseded capture locally when its delayed replay is rejected", async () => {
    const { storage } = memoryStorage();
    const queued = await enqueueCapture(storage, capture("superseded"));
    const send = vi.fn(async () => { throw new LocalApiError("Capture was superseded", 409); });
    expect(await flushCaptureQueue(storage, "token", send)).toMatchObject({ flushed: 0, remaining: 1 });
    expect(await loadCaptureQueue(storage)).toEqual([queued.item]);
  });

  it("keeps a superseded entry while syncing a newer capture through the real API adapter", async () => {
    const { storage } = memoryStorage();
    const old = await enqueueCapture(storage, capture("old"), new Date("2020-01-01T00:00:00Z"));
    const fresh = await enqueueCapture(storage, capture("new"), new Date("2020-01-02T00:00:00Z"));
    const sent: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as ExtensionCaptureIngestRequest;
      sent.push(body.captureId!);
      if (body.captureId === old.item.capture.captureId) {
        return Response.json({ ok: false, error: "extension_capture_superseded" }, { status: 409 });
      }
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.captureId));
      const itemId = `extension:${Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      return Response.json({ ...acknowledged(body), itemId });
    };
    const result = await flushCaptureQueue(storage, "token", (token, item) =>
      postExtensionCapture(token, item, { fetchImpl }));
    expect(result).toMatchObject({ flushed: 1, remaining: 1,
      failure: "A superseded capture remains saved locally; review it or discard it individually.",
      acknowledgements: [{ id: fresh.item.id, jobKey: null }] });
    expect(sent).toEqual([old.item.capture.captureId, fresh.item.capture.captureId]);
    expect(await loadCaptureQueue(storage)).toEqual([{ ...old.item, reviewStatus: "superseded" }]);
    expect(await flushCaptureQueue(storage, "token", (token, item) => postExtensionCapture(token, item, { fetchImpl })))
      .toMatchObject({ flushed: 0, remaining: 1 });
    expect(sent).toHaveLength(2);
  });

  it("does not skip an unrelated 409 conflict", async () => {
    const { storage } = memoryStorage();
    const old = await enqueueCapture(storage, capture("old"), new Date("2020-01-01T00:00:00Z"));
    const fresh = await enqueueCapture(storage, capture("new"), new Date("2020-01-02T00:00:00Z"));
    const fetchImpl = vi.fn(async () => Response.json({ ok: false, error: "manual_capture_state_changed" }, { status: 409 }));
    const result = await flushCaptureQueue(storage, "token", (token, item) =>
      postExtensionCapture(token, item, { fetchImpl }));
    expect(result).toMatchObject({ flushed: 0, remaining: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await loadCaptureQueue(storage)).toEqual([old.item, fresh.item]);
  });

  it("honors a clear during a send without sending later discarded entries", async () => {
    const { storage } = memoryStorage();
    await enqueueCapture(storage, capture("one"));
    await enqueueCapture(storage, capture("two"));
    const started = deferred();
    const release = deferred();
    const send = vi.fn(async (_token: string, item: ExtensionCaptureIngestRequest) => {
      started.resolve(); await release.promise; return acknowledged(item);
    });
    const flushing = flushCaptureQueue(storage, "token", send);
    await started.promise;
    await clearCaptureQueue(storage);
    await enqueueCapture(storage, capture("three"));
    release.resolve();
    expect(await flushing).toMatchObject({ flushed: 1, remaining: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect((await loadCaptureQueue(storage))[0]?.capture.contentText).toBe("Synthetic three");
  });

  it("persists a legacy capture ID before sending and reuses it after a failed attempt", async () => {
    const fixture = memoryStorage([{ id: "legacy", queuedAt: "2020-01-01T00:00:00Z", capture: capture("old") }]);
    const ids: string[] = [];
    const send = vi.fn(async (_token: string, item: ExtensionCaptureIngestRequest) => {
      expect(fixture.raw()).toMatchObject([{ capture: { captureId: item.captureId } }]);
      ids.push(item.captureId!);
      throw new Error("synthetic offline");
    });
    expect(await flushCaptureQueue(fixture.storage, "token", send)).toMatchObject({ flushed: 0, remaining: 1 });
    expect(await flushCaptureQueue(fixture.storage, "token", send)).toMatchObject({ flushed: 0, remaining: 1 });
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBe(ids[0]);
  });

  it("preserves inspectable data after read, acknowledgement-write, and explicit-clear failures", async () => {
    const fixture = memoryStorage();
    await enqueueCapture(fixture.storage, capture("one"));
    const before = fixture.raw();
    fixture.failGet(true);
    await expect(loadCaptureQueue(fixture.storage)).rejects.toThrow(/could not be read/i);
    fixture.failGet(false);
    expect(fixture.raw()).toEqual(before);
    fixture.failSet(true);
    await expect(flushCaptureQueue(fixture.storage, "token", async (_token, item) => acknowledged(item)))
      .rejects.toThrow(/synthetic write failure/);
    fixture.failSet(false);
    expect(fixture.raw()).toEqual(before);
    fixture.failRemove(true);
    await expect(clearCaptureQueue(fixture.storage)).rejects.toThrow(/synthetic clear failure/);
    fixture.failRemove(false);
    expect(await loadCaptureQueue(fixture.storage)).toEqual(before);
    await clearCaptureQueue(fixture.storage);
    expect(await loadCaptureQueue(fixture.storage)).toEqual([]);
  });

  it("fails closed on malformed stored data and leaves it available for explicit clear", async () => {
    const malformed = [{ id: "bad" }, { id: "good", queuedAt: "2020-01-01T00:00:00Z", capture: capture("good") }];
    const fixture = memoryStorage(malformed);
    await expect(loadCaptureQueue(fixture.storage)).rejects.toThrow(/unreadable.*stored data was kept/i);
    await expect(enqueueCapture(fixture.storage, capture("new"))).rejects.toThrow(/unreadable/i);
    expect(fixture.raw()).toEqual(malformed);
    await clearCaptureQueue(fixture.storage);
    expect(await loadCaptureQueue(fixture.storage)).toEqual([]);
  });
});
