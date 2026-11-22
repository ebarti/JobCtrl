import type { TenantId } from "@jobctrl/domain-types";

import type {
  DomainEventEnvelope,
  EventStreamPort,
  EventStreamStatus,
  EventStreamSubscription,
} from "../../ports/EventStreamPort.js";
import { parseDomainEvent } from "../../ports/lib/parseDomainEvent.js";
import type { SharedStreamCommand } from "./SseEventStreamWorker.js";

const STREAM_PATH = "/v1/events/stream";
const WORKER_HEARTBEAT_MS = 5_000;
const WORKER_DEADLINE_MS = 20_000;
const WORKER_RETRY_MAX_MS = 30_000;

export class SseEventStreamAdapter implements EventStreamPort {
  private readonly baseUrl: string;
  // Per target §6.4 the port has a coarse status; per-subscription state is
  // owned by the SseSubscription. The aggregate status reported here is
  // the most recent subscription's last-known state.
  private currentStatus: EventStreamStatus = "connecting";

  constructor(baseUrl = "") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  get status(): EventStreamStatus {
    return this.currentStatus;
  }

  subscribe({ tenantId }: { tenantId: TenantId }): EventStreamSubscription {
    const subscription = new SseSubscription(this.streamUrl(tenantId), (next) => {
      this.currentStatus = next;
    });
    return subscription;
  }

  private streamUrl(tenantId: TenantId): string {
    // A fresh mount reconciles current reads on open; avoid replaying all
    // historical events. EventSource sends Last-Event-ID on later reconnects.
    const search = new URLSearchParams({ tenantId, envelope: "1", after: "latest" }).toString();
    return `${this.baseUrl}${STREAM_PATH}?${search}`;
  }
}

class SseSubscription implements EventStreamSubscription {
  private readonly eventHandlers = new Set<(event: DomainEventEnvelope) => void>();
  private readonly invalidHandlers = new Set<() => void>();
  private readonly statusHandlers = new Set<(status: EventStreamStatus) => void>();
  private currentStatus: EventStreamStatus = "connecting";
  private closed = false;
  private workspaceChanged = false;
  private pagePaused = false;
  private readonly listenerCleanup: Array<() => void> = [];
  private source: EventSource | null = null;
  private worker: SharedWorker | null = null;
  private workerCleanup: (() => void) | null = null;
  private workerHeartbeat: ReturnType<typeof setInterval> | undefined;
  private workerRetry: ReturnType<typeof setTimeout> | undefined;
  private retryDelayMs = 1_000;
  private readonly onPageHide = () => {
    this.pagePaused = true;
    clearTimeout(this.workerRetry);
    this.workerRetry = undefined;
    this.closeWorker();
    this.closeSource();
    if (!this.workspaceChanged) this.setStatus("closed");
  };
  private readonly onPageShow = () => {
    if (!this.pagePaused || this.closed || this.workspaceChanged) return;
    this.pagePaused = false;
    this.openTransport();
  };

  constructor(
    private readonly url: string,
    private readonly notifyParent: (status: EventStreamStatus) => void,
  ) {
    globalThis.addEventListener("pagehide", this.onPageHide);
    globalThis.addEventListener("pageshow", this.onPageShow);
    this.openTransport();
  }

  get status(): EventStreamStatus {
    return this.currentStatus;
  }

  on(handler: (event: DomainEventEnvelope) => void): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  onInvalid(handler: () => void): () => void {
    this.invalidHandlers.add(handler);
    return () => { this.invalidHandlers.delete(handler); };
  }

  onStatusChange(handler: (status: EventStreamStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    globalThis.removeEventListener("pagehide", this.onPageHide);
    globalThis.removeEventListener("pageshow", this.onPageShow);
    clearTimeout(this.workerRetry);
    this.workerRetry = undefined;
    this.closeWorker();
    this.closeSource();
    this.setStatus("closed");
  }

  private closeSource(): void {
    for (const cleanup of this.listenerCleanup) {
      cleanup();
    }
    this.listenerCleanup.length = 0;
    this.source?.close();
    this.source = null;
  }

  private openTransport(): void {
    if (typeof SharedWorker === "undefined") this.open();
    else this.openShared();
  }

  private openShared(): void {
    if (this.closed || this.workspaceChanged || this.pagePaused) return;
    let worker: SharedWorker;
    try {
      const target = new URL(this.url, globalThis.location.href).href;
      worker = new SharedWorker(new URL("./SseEventStreamWorker.ts", import.meta.url), {
        type: "module", name: `jobctrl-event-stream:${target}`,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotSupportedError") this.open();
      else this.retryShared();
      return;
    }
    this.worker = worker;
    this.setStatus("connecting");
    let lastActivity = Date.now();
    const current = () => this.worker === worker && !this.closed && !this.workspaceChanged && !this.pagePaused;
    const send = (command: SharedStreamCommand) => worker.port.postMessage(command);
    const failed = () => { if (current()) this.retryShared(); };
    const onMessage = (event: MessageEvent<unknown>) => {
      if (!current()) return;
      lastActivity = Date.now();
      const message = event.data;
      if (!message || typeof message !== "object" || !("type" in message)) {
        this.invalidFrame(); failed(); return;
      }
      if (message.type === "frame" && "data" in message && typeof message.data === "string") {
        this.handleEvent({ data: message.data } as MessageEvent); return;
      }
      if (message.type === "heartbeat") return;
      if (message.type === "unsupported") {
        // Only an unavailable platform primitive permits the per-page fallback.
        this.closeWorker(); this.open(); return;
      }
      if (message.type === "expired") { failed(); return; }
      if (message.type === "status" && "status" in message) {
        const next = message.status;
        if (next === "workspace_changed") {
          this.workspaceChanged = true;
          this.closeWorker();
          this.setStatus("workspace_changed");
          return;
        }
        if (next === "open" || next === "connecting" || next === "closed") {
          if (next === "open") this.retryDelayMs = 1_000;
          this.setStatus(next); return;
        }
      }
      this.invalidFrame(); failed();
    };
    const onError = (event: Event) => { event.preventDefault(); failed(); };
    worker.port.addEventListener("message", onMessage);
    worker.port.addEventListener("messageerror", onError);
    worker.addEventListener("error", onError);
    this.workerCleanup = () => {
      worker.port.removeEventListener("message", onMessage);
      worker.port.removeEventListener("messageerror", onError);
      worker.removeEventListener("error", onError);
      try { send({ type: "unsubscribe" }); } catch { /* An already failed port owns no live subscription. */ }
      worker.port.close();
    };
    worker.port.start();
    this.workerHeartbeat = setInterval(() => {
      if (!current()) return;
      if (Date.now() - lastActivity > WORKER_DEADLINE_MS) { failed(); return; }
      try { send({ type: "ping" }); } catch { failed(); }
    }, WORKER_HEARTBEAT_MS);
    try { send({ type: "subscribe", url: new URL(this.url, globalThis.location.href).href }); }
    catch { failed(); }
  }

  private closeWorker(): void {
    clearInterval(this.workerHeartbeat);
    this.workerHeartbeat = undefined;
    this.worker = null;
    this.workerCleanup?.();
    this.workerCleanup = null;
  }

  private retryShared(): void {
    this.closeWorker();
    if (this.closed || this.workspaceChanged || this.pagePaused || this.workerRetry !== undefined) return;
    this.setStatus("closed");
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(WORKER_RETRY_MAX_MS, delay * 2);
    this.workerRetry = setTimeout(() => { this.workerRetry = undefined; this.openShared(); }, delay);
  }

  private open(): void {
    if (this.closed || this.workspaceChanged || this.pagePaused) return;
    if (typeof EventSource === "undefined") {
      this.setStatus("closed");
      return;
    }
    const source = new EventSource(this.url);
    this.source = source;
    this.setStatus("connecting");

    const onOpen = () => {
      if (!this.workspaceChanged) this.setStatus("open");
    };
    // A changed workspace requires an explicit fresh subscription. A network
    // reconnect on the old EventSource must not hide that recovery instruction.
    const onError = (event: Event) => {
      if (isWorkspaceChanged(event)) {
        this.workspaceChanged = true;
        this.setStatus("workspace_changed");
      } else if (!this.workspaceChanged) {
        this.setStatus("closed");
      }
    };
    source.addEventListener("open", onOpen);
    source.addEventListener("error", onError);
    this.listenerCleanup.push(() => source.removeEventListener("open", onOpen));
    this.listenerCleanup.push(() => source.removeEventListener("error", onError));

    // Envelope mode delivers every producer's event on one channel. A new or
    // unregistered event must still reach the shell's conservative fallback.
    const onMessage = (raw: MessageEvent) => this.handleEvent(raw);
    source.addEventListener("message", onMessage);
    this.listenerCleanup.push(() => source.removeEventListener("message", onMessage));

    const onWorkspaceChanged = () => {
      this.workspaceChanged = true;
      source.close();
      this.setStatus("workspace_changed");
    };
    source.addEventListener("workspace_changed", onWorkspaceChanged);
    this.listenerCleanup.push(() => source.removeEventListener("workspace_changed", onWorkspaceChanged));

    const heartbeatListener = () => {
      if (!this.workspaceChanged) this.setStatus("open");
    };
    source.addEventListener("heartbeat", heartbeatListener);
    this.listenerCleanup.push(() => source.removeEventListener("heartbeat", heartbeatListener));
  }

  private handleEvent(raw: MessageEvent): void {
    if (this.closed || this.workspaceChanged) {
      return;
    }
    const data = typeof raw.data === "string" ? raw.data : null;
    let eventType: unknown;
    try {
      const envelope: unknown = JSON.parse(data ?? "");
      if (envelope && typeof envelope === "object" && "type" in envelope) eventType = envelope.type;
    } catch { this.invalidFrame(); return; }
    if (typeof eventType !== "string" || !eventType) { this.invalidFrame(); return; }
    const result = parseDomainEvent({
      eventType,
      data,
    });
    if (!result.ok) {
      this.invalidFrame();
      return;
    }
    for (const handler of this.eventHandlers) {
      handler(result.envelope);
    }
  }

  private invalidFrame(): void {
    for (const handler of this.invalidHandlers) handler();
  }

  private setStatus(next: EventStreamStatus): void {
    if (this.currentStatus === next) {
      return;
    }
    this.currentStatus = next;
    this.notifyParent(next);
    for (const handler of this.statusHandlers) {
      handler(next);
    }
  }
}


function isWorkspaceChanged(event: Event): boolean {
  const data = (event as MessageEvent<unknown>).data;
  if (typeof data !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      && (parsed as Record<string, unknown>).code === "event_stream_workspace_changed";
  } catch {
    return false;
  }
}
