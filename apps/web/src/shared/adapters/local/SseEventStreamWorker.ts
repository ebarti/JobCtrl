import type { EventStreamStatus } from "../../ports/EventStreamPort.js";

export type SharedStreamCommand =
  | { readonly type: "subscribe"; readonly url: string }
  | { readonly type: "ping" }
  | { readonly type: "unsubscribe" };

export type SharedStreamMessage =
  | { readonly type: "status"; readonly status: EventStreamStatus }
  | { readonly type: "frame"; readonly data: string }
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
  next.addEventListener("open", () => { if (source === next && !workspaceChanged) setStatus("open"); });
  next.addEventListener("error", (event) => {
    if (source !== next || workspaceChanged) return;
    const data: unknown = (event as MessageEvent<unknown>).data;
    if (typeof data === "string") {
      try {
        const value: unknown = JSON.parse(data);
        if (value && typeof value === "object" && "code" in value && value.code === "event_stream_workspace_changed") {
          changedWorkspace(); return;
        }
      } catch { /* A normal network error has no domain payload. */ }
    }
    // Keep this EventSource: its own reconnect retains Last-Event-ID.
    setStatus("closed");
  });
  next.addEventListener("workspace_changed", () => { if (source === next) changedWorkspace(); });
  next.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (source !== next || workspaceChanged) return;
    if (event.lastEventId && /^\d+$/.test(event.lastEventId)) lastEventId = event.lastEventId;
    // Domain schema validation remains in every page's adapter subscription.
    if (typeof event.data === "string") broadcast({ type: "frame", data: event.data });
    else broadcast({ type: "transport_error" });
  });
}

function subscribe(port: MessagePort, url: string): void {
  if (target !== null && target !== url) { post(port, { type: "transport_error" }); disconnect(port); return; }
  target = url;
  subscribers.set(port, Date.now());
  if (sweep === undefined) sweep = setInterval(() => {
    const oldest = Date.now() - LEASE_TIMEOUT_MS;
    for (const [subscriber, lastSeen] of subscribers) {
      if (lastSeen < oldest) { post(subscriber, { type: "expired" }); disconnect(subscriber); }
    }
  }, LEASE_CHECK_MS);
  open();
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
    if (command.type === "subscribe" && "url" in command && typeof command.url === "string") subscribe(port, command.url);
    else if (command.type === "unsubscribe") disconnect(port);
    else if (command.type === "ping" && subscribers.has(port)) {
      subscribers.set(port, Date.now());
      post(port, { type: "heartbeat" });
    } else { post(port, { type: "transport_error" }); disconnect(port); }
  };
  port.onmessageerror = () => { post(port, { type: "transport_error" }); disconnect(port); };
  port.start();
};
