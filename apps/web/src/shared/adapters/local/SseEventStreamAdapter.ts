import { DOMAIN_EVENT_TYPES, type TenantId } from "@jobctrl/domain-types";

import type {
  DomainEventEnvelope,
  EventStreamPort,
  EventStreamStatus,
  EventStreamSubscription,
} from "../../ports/EventStreamPort.js";
import { parseDomainEvent } from "../../ports/lib/parseDomainEvent.js";

const STREAM_PATH = "/v1/events/stream";

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
    const search = new URLSearchParams({ tenantId }).toString();
    return `${this.baseUrl}${STREAM_PATH}?${search}`;
  }
}

class SseSubscription implements EventStreamSubscription {
  private readonly eventHandlers = new Set<(event: DomainEventEnvelope) => void>();
  private readonly statusHandlers = new Set<(status: EventStreamStatus) => void>();
  private currentStatus: EventStreamStatus = "connecting";
  private closed = false;
  private readonly listenerCleanup: Array<() => void> = [];
  private source: EventSource | null = null;

  constructor(
    private readonly url: string,
    private readonly notifyParent: (status: EventStreamStatus) => void,
  ) {
    this.open();
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
    for (const cleanup of this.listenerCleanup) {
      cleanup();
    }
    this.listenerCleanup.length = 0;
    this.source?.close();
    this.source = null;
    this.setStatus("closed");
  }

  private open(): void {
    if (typeof EventSource === "undefined") {
      this.setStatus("closed");
      return;
    }
    const source = new EventSource(this.url);
    this.source = source;
    this.setStatus("connecting");

    const onOpen = () => this.setStatus("open");
    // EventSource uses 'error' to signal both transient drops (it
    // auto-reconnects per the server's `retry:`) and permanent
    // failures.  We surface 'closed' on every error tick; callers
    // observe the next 'open' to learn that reconnect succeeded.
    const onError = () => this.setStatus("closed");
    source.addEventListener("open", onOpen);
    source.addEventListener("error", onError);
    this.listenerCleanup.push(() => source.removeEventListener("open", onOpen));
    this.listenerCleanup.push(() => source.removeEventListener("error", onError));

    for (const eventType of DOMAIN_EVENT_TYPES) {
      const listener = (raw: MessageEvent) => this.handleEvent(eventType, raw);
      source.addEventListener(eventType, listener);
      this.listenerCleanup.push(() => source.removeEventListener(eventType, listener));
    }

    const heartbeatListener = () => this.setStatus("open");
    source.addEventListener("heartbeat", heartbeatListener);
    this.listenerCleanup.push(() => source.removeEventListener("heartbeat", heartbeatListener));
  }

  private handleEvent(eventType: string, raw: MessageEvent): void {
    if (this.closed) {
      return;
    }
    const result = parseDomainEvent({
      eventType,
      data: typeof raw.data === "string" ? raw.data : null,
    });
    if (!result.ok) {
      return;
    }
    for (const handler of this.eventHandlers) {
      handler(result.envelope);
    }
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

