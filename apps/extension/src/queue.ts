import { ExtensionCaptureIngestSchema, type ExtensionCaptureIngestRequest } from "@jobctrl/contracts";

import type { BrowserStorageArea } from "./browser";
import { LocalApiError, postExtensionCapture } from "./local-api";

export const CAPTURE_QUEUE_STORAGE_KEY = "jobctrlCaptureQueue";
export const MAX_CAPTURE_QUEUE_SIZE = 25;

export interface QueuedCapture {
  id: string;
  queuedAt: string;
  capture: ExtensionCaptureIngestRequest;
}

export interface EnqueueResult {
  item: QueuedCapture;
  queueSize: number;
}

export interface FlushResult {
  flushed: number;
  remaining: number;
  acknowledgements: Array<{ id: string; jobKey: string | null }>;
  failure: string | null;
}

export class CaptureQueueUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureQueueUnavailableError";
  }
}

// The extension's background worker is the only writer. Serialize short
// read/modify/write operations, but never hold this lock across a network send.
const mutations = new WeakMap<BrowserStorageArea, Promise<void>>();
const flushes = new WeakMap<BrowserStorageArea, { token: string; promise: Promise<FlushResult> }>();

function withQueueLock<T>(storage: BrowserStorageArea, operation: () => Promise<T>): Promise<T> {
  const previous = mutations.get(storage) ?? Promise.resolve();
  const result = previous.then(operation);
  const settled = result.then(() => undefined, () => undefined);
  mutations.set(storage, settled);
  void settled.then(() => {
    if (mutations.get(storage) === settled) mutations.delete(storage);
  });
  return result;
}

async function readQueue(storage: BrowserStorageArea): Promise<QueuedCapture[]> {
  let raw: Record<string, unknown>;
  try {
    raw = await storage.get(CAPTURE_QUEUE_STORAGE_KEY);
  } catch {
    throw new CaptureQueueUnavailableError("The local capture queue could not be read. Retry or use Clear queue to discard it.");
  }
  const value = raw[CAPTURE_QUEUE_STORAGE_KEY];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isQueuedCapture) || new Set(value.map((item) => item.id)).size !== value.length) {
    throw new CaptureQueueUnavailableError("The local capture queue is unreadable. Its stored data was kept; use Clear queue only to discard it.");
  }
  return [...value].sort((left, right) => left.queuedAt.localeCompare(right.queuedAt));
}

export function loadCaptureQueue(storage: BrowserStorageArea): Promise<QueuedCapture[]> {
  return withQueueLock(storage, () => readQueue(storage));
}

export function enqueueCapture(
  storage: BrowserStorageArea,
  capture: ExtensionCaptureIngestRequest,
  now = new Date(),
): Promise<EnqueueResult> {
  const parsed = ExtensionCaptureIngestSchema.parse(capture);
  const item: QueuedCapture = {
    id: `capture-${crypto.randomUUID()}`,
    queuedAt: now.toISOString(),
    capture: parsed.captureId ? parsed : { ...parsed, captureId: crypto.randomUUID() },
  };
  return withQueueLock(storage, async () => {
    const queue = await readQueue(storage);
    if (queue.length >= MAX_CAPTURE_QUEUE_SIZE) {
      throw new Error("The local capture queue is full (25). This page was not saved; reconnect and retry, or clear the queue to discard pending captures.");
    }
    queue.push(item);
    await storage.set({ [CAPTURE_QUEUE_STORAGE_KEY]: queue });
    return { item, queueSize: queue.length };
  });
}

export function flushCaptureQueue(
  storage: BrowserStorageArea,
  token: string,
  sendCapture = postExtensionCapture,
): Promise<FlushResult> {
  const existing = flushes.get(storage);
  if (existing?.token === token) return existing.promise;
  // Different credentials require a fresh snapshot, but still must not send
  // concurrently with the existing flush. Retry even if that flush rejected.
  const run = () => flushSnapshot(storage, token, sendCapture);
  const flushing = existing ? existing.promise.then(run, run) : run();
  const pending = { token, promise: flushing };
  flushes.set(storage, pending);
  void flushing.then(
    () => { if (flushes.get(storage) === pending) flushes.delete(storage); },
    () => { if (flushes.get(storage) === pending) flushes.delete(storage); },
  );
  return flushing;
}

async function flushSnapshot(
  storage: BrowserStorageArea,
  token: string,
  sendCapture: typeof postExtensionCapture,
): Promise<FlushResult> {
  const snapshot = await loadCaptureQueue(storage);
  const acknowledgements: FlushResult["acknowledgements"] = [];
  let failure: string | null = null;
  for (const queued of snapshot) {
    const item = await withQueueLock(storage, async () => {
      const queue = await readQueue(storage);
      const index = queue.findIndex((candidate) => candidate.id === queued.id);
      if (index < 0) return null;
      const current = queue[index]!;
      if (current.capture.captureId) return current;
      // Older queues did not persist captureId. Save one before sending, so a
      // later retry uses the same API identity even if acknowledgement is lost.
      const upgraded = { ...current, capture: { ...current.capture, captureId: crypto.randomUUID() } };
      queue[index] = upgraded;
      await storage.set({ [CAPTURE_QUEUE_STORAGE_KEY]: queue });
      return upgraded;
    });
    if (!item) continue; // An explicit clear removed this item before its send.
    let response;
    try {
      response = await sendCapture(token, item.capture);
    } catch (error) {
      failure = error instanceof LocalApiError
        ? error.status === 401 || error.status === 403
          ? "JobCtrl rejected the pairing token. Copy a fresh token from Settings."
          : error.message
        : "Local JobCtrl API is unavailable.";
      break;
    }
    await withQueueLock(storage, async () => {
      const queue = await readQueue(storage);
      const index = queue.findIndex((candidate) =>
        candidate.id === item.id && candidate.capture.captureId === item.capture.captureId,
      );
      if (index < 0) return;
      queue.splice(index, 1);
      await storage.set({ [CAPTURE_QUEUE_STORAGE_KEY]: queue });
    });
    acknowledgements.push({ id: item.id, jobKey: response.jobKey });
  }
  return { flushed: acknowledgements.length, remaining: (await loadCaptureQueue(storage)).length, acknowledgements, failure };
}

export function clearCaptureQueue(storage: BrowserStorageArea): Promise<void> {
  return withQueueLock(storage, () => storage.remove(CAPTURE_QUEUE_STORAGE_KEY));
}

function isQueuedCapture(value: unknown): value is QueuedCapture {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" && candidate.id.length > 0 &&
    typeof candidate.queuedAt === "string" && Number.isFinite(Date.parse(candidate.queuedAt)) &&
    ExtensionCaptureIngestSchema.safeParse(candidate.capture).success
  );
}
