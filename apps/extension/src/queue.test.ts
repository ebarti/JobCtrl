import { describe, expect, it, vi } from "vitest";

import type { BrowserStorageArea } from "./browser";
import {
  CAPTURE_QUEUE_RETENTION_MS,
  CAPTURE_QUEUE_STORAGE_KEY,
  MAX_CAPTURE_QUEUE_SIZE,
  enqueueCapture,
  flushCaptureQueue,
  loadCaptureQueue,
} from "./queue";

describe("extension capture queue", () => {
  it("bounds queued captures and keeps the newest entries", async () => {
    const storage = memoryStorage();
    for (let index = 0; index < MAX_CAPTURE_QUEUE_SIZE + 2; index += 1) {
      await enqueueCapture(
        storage,
        capture(`https://example.com/jobs/${index}`),
        new Date(`2026-07-05T00:00:${String(index).padStart(2, "0")}Z`),
      );
    }

    const queue = await loadCaptureQueue(storage, new Date("2026-07-05T00:01:00Z"));

    expect(queue).toHaveLength(MAX_CAPTURE_QUEUE_SIZE);
    expect(queue[0]?.capture.originatingUrl).toBe("https://example.com/jobs/2");
  });

  it("drops expired queued captures", async () => {
    const storage = memoryStorage();
    await enqueueCapture(storage, capture("https://example.com/jobs/old"), new Date("2026-07-01T00:00:00Z"));

    const queue = await loadCaptureQueue(
      storage,
      new Date(new Date("2026-07-01T00:00:00Z").getTime() + CAPTURE_QUEUE_RETENTION_MS + 1),
    );

    expect(queue).toHaveLength(0);
  });

  it("flushes queued captures in order and retains the first failed capture", async () => {
    const storage = memoryStorage();
    await enqueueCapture(storage, capture("https://example.com/jobs/1"));
    await enqueueCapture(storage, capture("https://example.com/jobs/2"));
    const sendCapture = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("down"));

    const result = await flushCaptureQueue(storage, "token", sendCapture);
    const queue = await loadCaptureQueue(storage);

    expect(result).toEqual({ flushed: 1, remaining: 1 });
    expect(queue[0]?.capture.originatingUrl).toBe("https://example.com/jobs/2");
  });

  it("ignores malformed stored queue entries", async () => {
    const storage = memoryStorage({
      [CAPTURE_QUEUE_STORAGE_KEY]: [{ id: "bad" }, { id: "good", queuedAt: new Date().toISOString(), capture: capture("https://example.com/jobs/good") }],
    });

    await expect(loadCaptureQueue(storage)).resolves.toHaveLength(1);
  });
});

function capture(url: string) {
  return {
    originatingUrl: url,
    captureMode: "current_page" as const,
    capturedUrl: url,
    contentText: "Role description",
    futureManualActionRequired: false,
    captureClient: "browser_extension" as const,
    extensionVersion: "0.3.0",
  };
}

function memoryStorage(initial: Record<string, unknown> = {}): BrowserStorageArea {
  const store = new Map(Object.entries(initial));
  return {
    async get(keys?: string | string[] | Record<string, unknown> | null) {
      if (typeof keys === "string") {
        return { [keys]: store.get(keys) };
      }
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, store.get(key)]));
      }
      return Object.fromEntries(store);
    },
    async set(items: Record<string, unknown>) {
      for (const [key, value] of Object.entries(items)) {
        store.set(key, value);
      }
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        store.delete(key);
      }
    },
  };
}
