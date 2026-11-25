import type { EventStreamStatus } from "../../ports/EventStreamPort.js";
import { cursorDatabase, isStreamCursor } from "./sseCursor.js";

export type SharedStreamCommand =
  | { readonly type: "subscribe"; readonly url: string; readonly cursor: string | null }
  | { readonly type: "ping" }
  | { readonly type: "unsubscribe" };

export type SharedStreamMessage =
  | { readonly type: "status"; readonly status: EventStreamStatus }
  | { readonly type: "cursor"; readonly cursor: string }
  | { readonly type: "frame"; readonly data: string; readonly cursor: string }
  | { readonly type: "heartbeat" }
  | { readonly type: "expired" }
  | { readonly type: "unsupported" }
  | { readonly type: "transport_error" };

const LEASE_TIMEOUT_MS = 90_000;
const LEASE_CHECK_MS = 15_000;
const subscribers = new Map<MessagePort, number>();
let target: string | null = null;
let source: EventSource | null = null;
let lastEventId: string | null = null;
let status: EventStreamStatus = "connecting";
let workspaceChanged = false;
let sweep: ReturnType<typeof setInterval> | undefined;

function post(port: MessagePort, message: SharedStreamMessage): boolean {
  try { port.postMessage(message); return true; }
  catch { return false; }
}

function disconnect(port: MessagePort): void {
  subscribers.delete(port);
  port.onmessage = null;
  port.onmessageerror = null;
  port.close();
  if (subscribers.size) return;
  source?.close();
  source = null;
  clearInterval(sweep);
  sweep = undefined;
  // A fresh subscription is allowed after every terminal subscriber has left.
  // Existing page subscriptions keep their own terminal workspace-change latch.
  if (workspaceChanged) { workspaceChanged = false; lastEventId = null; }
  status = "closed";
}

function broadcast(message: SharedStreamMessage): void {
  for (const port of subscribers.keys()) if (!post(port, message)) disconnect(port);
}

function setStatus(next: EventStreamStatus): void {
  if (status === next) return;
  status = next;
  broadcast({ type: "status", status: next });
}

function changedWorkspace(): void {
  workspaceChanged = true;
  source?.close();
  source = null;
  setStatus("workspace_changed");
}

function open(): void {
  if (source || workspaceChanged || !target || !subscribers.size) return;
  if (typeof EventSource === "undefined") { broadcast({ type: "unsupported" }); return; }
  const url = new URL(target);
  if (lastEventId !== null) url.searchParams.set("after", lastEventId);
  let next: EventSource;
  try { next = new EventSource(url.href); }
  catch (error) {
    if (error instanceof DOMException && error.name === "NotSupportedError") broadcast({ type: "unsupported" });
    else { setStatus("closed"); broadcast({ type: "transport_error" }); }
    return;
  }
  source = next;
  setStatus("connecting");
  next.addEventListener("error", () => {
    if (source !== next || workspaceChanged) return;
    setStatus("closed");
    // A fatal HTTP response closes EventSource permanently. The page retries
    // the shared transport; an ordinary disconnect keeps native cursor replay.
    if (next.readyState === EventSource.CLOSED) {
      source = null;
      broadcast({ type: "transport_error" });
    }
  });
  next.addEventListener("workspace_changed", () => { if (source === next) changedWorkspace(); });
  next.addEventListener("stream_cursor", (event: MessageEvent<unknown>) => {
    if (source !== next || workspaceChanged) return;
    if (rememberCursor(event.lastEventId)) {
      broadcast({ type: "cursor", cursor: event.lastEventId });
      setStatus("open");
    }
  });
  next.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (source !== next || workspaceChanged) return;
    // Domain schema validation remains in every page's adapter subscription.
    if (rememberCursor(event.lastEventId) && typeof event.data === "string") {
      broadcast({ type: "frame", data: event.data, cursor: event.lastEventId });
      setStatus("open");
    }
  });
}

function rememberCursor(cursor: string): boolean {
  if (!isStreamCursor(cursor)) { broadcast({ type: "transport_error" }); return false; }
  const expectedDatabase = lastEventId === null ? undefined : cursorDatabase(lastEventId);
  if (expectedDatabase && expectedDatabase !== cursorDatabase(cursor)) {
    changedWorkspace();
    return false;
  }
  lastEventId = cursor;
  return true;
}

function subscribe(port: MessagePort, url: string, cursor: string | null): void {
  if (target !== null && target !== url) { post(port, { type: "transport_error" }); disconnect(port); return; }
  const expectedDatabase = cursor === null ? undefined : cursorDatabase(cursor);
  if (expectedDatabase && lastEventId !== null && expectedDatabase !== cursorDatabase(lastEventId)) {
    post(port, { type: "status", status: "workspace_changed" }); disconnect(port); return;
  }
  target = url;
  lastEventId ??= cursor;
  subscribers.set(port, Date.now());
  if (sweep === undefined) sweep = setInterval(() => {
    const oldest = Date.now() - LEASE_TIMEOUT_MS;
    for (const [subscriber, lastSeen] of subscribers) {
      if (lastSeen < oldest) { post(subscriber, { type: "expired" }); disconnect(subscriber); }
    }
  }, LEASE_CHECK_MS);
  open();
  if (lastEventId !== null) post(port, { type: "cursor", cursor: lastEventId });
  post(port, { type: "status", status });
}

const scope = globalThis as unknown as { onconnect: (event: MessageEvent) => void };
scope.onconnect = (event) => {
  const port = event.ports[0];
  if (!port) return;
  port.onmessage = (message: MessageEvent<unknown>) => {
    const command = message.data;
    if (!command || typeof command !== "object" || !("type" in command)) {
      post(port, { type: "transport_error" }); disconnect(port); return;
    }
    if (command.type === "subscribe" && "url" in command && typeof command.url === "string"
      && "cursor" in command && (command.cursor === null || (typeof command.cursor === "string" && isStreamCursor(command.cursor))))
      subscribe(port, command.url, command.cursor);
    else if (command.type === "unsubscribe") disconnect(port);
    else if (command.type === "ping" && subscribers.has(port)) {
      subscribers.set(port, Date.now());
      post(port, { type: "heartbeat" });
    } else { post(port, { type: "transport_error" }); disconnect(port); }
  };
  port.onmessageerror = () => { post(port, { type: "transport_error" }); disconnect(port); };
  port.start();
};
