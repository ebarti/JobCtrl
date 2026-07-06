import { ExtensionCaptureIngestSchema, type ExtensionCaptureIngestRequest } from "@jobhunter/contracts";

import type { BrowserStorageArea } from "./browser";
import { postExtensionCapture } from "./local-api";

export const CAPTURE_QUEUE_STORAGE_KEY = "jobhunterCaptureQueue";
export const MAX_CAPTURE_QUEUE_SIZE = 25;
export const CAPTURE_QUEUE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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
}

export async function loadCaptureQueue(
  storage: BrowserStorageArea,
  now = new Date(),
): Promise<QueuedCapture[]> {
  const raw = await storage.get(CAPTURE_QUEUE_STORAGE_KEY);
  const queue = Array.isArray(raw[CAPTURE_QUEUE_STORAGE_KEY]) ? raw[CAPTURE_QUEUE_STORAGE_KEY] : [];
  return queue
    .filter(isQueuedCapture)
    .filter((item) => !isExpired(item, now))
    .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt));
}

export async function enqueueCapture(
  storage: BrowserStorageArea,
  capture: ExtensionCaptureIngestRequest,
  now = new Date(),
): Promise<EnqueueResult> {
  const parsed = ExtensionCaptureIngestSchema.parse(capture);
  const item: QueuedCapture = {
    id: `capture-${crypto.randomUUID()}`,
    queuedAt: now.toISOString(),
    capture: parsed,
  };
  const queue = [...(await loadCaptureQueue(storage, now)), item].slice(-MAX_CAPTURE_QUEUE_SIZE);
  await storage.set({ [CAPTURE_QUEUE_STORAGE_KEY]: queue });
  return { item, queueSize: queue.length };
}

export async function flushCaptureQueue(
  storage: BrowserStorageArea,
  token: string,
  sendCapture = postExtensionCapture,
  now = new Date(),
): Promise<FlushResult> {
  const queue = await loadCaptureQueue(storage, now);
  const remaining: QueuedCapture[] = [];
  let flushed = 0;
  for (const item of queue) {
    try {
      await sendCapture(token, item.capture);
      flushed += 1;
    } catch {
      remaining.push(item, ...queue.slice(flushed + remaining.length + 1));
      break;
    }
  }
  await storage.set({ [CAPTURE_QUEUE_STORAGE_KEY]: remaining });
  return { flushed, remaining: remaining.length };
}

export async function clearCaptureQueue(storage: BrowserStorageArea): Promise<void> {
  await storage.remove(CAPTURE_QUEUE_STORAGE_KEY);
}

function isQueuedCapture(value: unknown): value is QueuedCapture {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.queuedAt === "string" &&
    ExtensionCaptureIngestSchema.safeParse(candidate.capture).success
  );
}

function isExpired(item: QueuedCapture, now: Date): boolean {
  const queued = Date.parse(item.queuedAt);
  if (!Number.isFinite(queued)) {
    return true;
  }
  return now.getTime() - queued > CAPTURE_QUEUE_RETENTION_MS;
}
