import {
  DOMAIN_EVENT_TYPES,
  LOCAL_TENANT,
  type TenantId,
} from "@jobctrl/domain-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SseEventStreamAdapter } from "./SseEventStreamAdapter.js";

class FakeEventSource {
  static readonly instances: FakeEventSource[] = [];

  readonly url: string;
  readonly close = vi.fn();
  private readonly listeners = new Map<
    string,
    Set<EventListenerOrEventListenerObject>
  >();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
  ): void {
    if (!listener) {
      return;
    }
    const listeners =
      this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
  ): void {
    if (!listener) {
      return;
    }
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, data?: unknown): void {
    const event =
      data === undefined ? new Event(type) : new MessageEvent(type, { data });
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      if (typeof listener === "function") {
        listener.call(this, event);
      } else {
        listener.handleEvent(event);
      }
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  totalListenerCount(): number {
    return [...this.listeners.values()].reduce(
      (total, listeners) => total + listeners.size,
      0,
    );
  }

  static reset(): void {
    FakeEventSource.instances.length = 0;
  }
}

function onlySource(): FakeEventSource {
  expect(FakeEventSource.instances).toHaveLength(1);
  return FakeEventSource.instances[0]!;
}

describe("SseEventStreamAdapter", () => {
  beforeEach(() => {
    FakeEventSource.reset();
    vi.stubGlobal(
      "EventSource",
      FakeEventSource as unknown as typeof EventSource,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    FakeEventSource.reset();
  });

  it("opens the tenant-scoped stream and dispatches a valid domain event", () => {
    const tenantId = "tenant / west" as TenantId;
    const adapter = new SseEventStreamAdapter("http://127.0.0.1:4100/");
    const subscription = adapter.subscribe({ tenantId });
    const source = onlySource();
    const handler = vi.fn();
    subscription.on(handler);

    const streamUrl = new URL(source.url);
    expect(streamUrl.origin).toBe("http://127.0.0.1:4100");
    expect(streamUrl.pathname).toBe("/v1/events/stream");
    expect(streamUrl.searchParams.get("tenantId")).toBe(tenantId);

    const payload = { tenantId, jobId: "job-1", fitScore: 91 };
    source.emit("JobScored", encodeEnvelope(payload));

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({
      eventType: "JobScored",
      tenantId,
      occurredAt: null,
      payload,
    });
  });

  it.each([
    ["missing data", undefined],
    ["empty data", ""],
    ["non-string data", { jobId: "job-1" }],
    ["invalid JSON", "not-json"],
    ["non-object JSON", "[1,2,3]"],
  ])(
    "drops %s without disrupting later valid delivery",
    (_case, malformedData) => {
      const adapter = new SseEventStreamAdapter();
      const subscription = adapter.subscribe({ tenantId: LOCAL_TENANT });
      const source = onlySource();
      const handler = vi.fn();
      subscription.on(handler);

      source.emit("JobScored", malformedData);
      expect(handler).not.toHaveBeenCalled();

      const payload = { tenantId: LOCAL_TENANT, jobId: "job-1" };
      source.emit("JobScored", encodeEnvelope(payload));
      expect(handler).toHaveBeenCalledOnce();
    },
  );

  it("removes consumer handlers without adding duplicate transport listeners", () => {
    const adapter = new SseEventStreamAdapter();
    const subscription = adapter.subscribe({ tenantId: LOCAL_TENANT });
    const source = onlySource();
    const removedEventHandler = vi.fn();
    const activeEventHandler = vi.fn();
    const statusHandler = vi.fn();
    const offRemovedEvent = subscription.on(removedEventHandler);
    const offActiveEvent = subscription.on(activeEventHandler);
    const offStatus = subscription.onStatusChange(statusHandler);

    expect(source.listenerCount("JobScored")).toBe(1);
    offRemovedEvent();
    source.emit("JobScored", encodeEnvelope({ jobId: "job-1" }));
    expect(removedEventHandler).not.toHaveBeenCalled();
    expect(activeEventHandler).toHaveBeenCalledOnce();

    offActiveEvent();
    source.emit("JobScored", encodeEnvelope({ jobId: "job-2" }));
    expect(activeEventHandler).toHaveBeenCalledOnce();
    expect(source.listenerCount("JobScored")).toBe(1);

    source.emit("open");
    offStatus();
    source.emit("error");
    expect(statusHandler).toHaveBeenCalledOnce();
    subscription.close();
  });

  it("reports open, network loss, and native reconnection without replacing the source", () => {
    const adapter = new SseEventStreamAdapter();
    const subscription = adapter.subscribe({ tenantId: LOCAL_TENANT });
    const source = onlySource();
    const statuses = vi.fn();
    const handler = vi.fn();
    subscription.onStatusChange(statuses);
    subscription.on(handler);

    expect(subscription.status).toBe("connecting");
    expect(adapter.status).toBe("connecting");

    source.emit("open");
    expect(subscription.status).toBe("open");
    expect(adapter.status).toBe("open");

    source.emit("error");
    source.emit("error");
    expect(subscription.status).toBe("closed");
    expect(adapter.status).toBe("closed");
    expect(source.close).not.toHaveBeenCalled();

    source.emit("open");
    expect(subscription.status).toBe("open");
    expect(adapter.status).toBe("open");
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(source.listenerCount("JobScored")).toBe(1);

    source.emit("JobScored", encodeEnvelope({ jobId: "job-1" }));
    expect(handler).toHaveBeenCalledOnce();
    expect(statuses.mock.calls.map(([status]) => status)).toEqual([
      "open",
      "closed",
      "open",
    ]);
  });

  it("treats a heartbeat as proof that the stream is live", () => {
    const adapter = new SseEventStreamAdapter();
    const subscription = adapter.subscribe({ tenantId: LOCAL_TENANT });
    const source = onlySource();
    const statuses = vi.fn();
    subscription.onStatusChange(statuses);

    source.emit("heartbeat");
    source.emit("heartbeat");
    expect(subscription.status).toBe("open");
    expect(adapter.status).toBe("open");

    source.emit("error");
    source.emit("heartbeat");
    expect(statuses.mock.calls.map(([status]) => status)).toEqual([
      "open",
      "closed",
      "open",
    ]);
  });

  it("removes every transport listener and closes the source exactly once", () => {
    const adapter = new SseEventStreamAdapter();
    const subscription = adapter.subscribe({ tenantId: LOCAL_TENANT });
    const source = onlySource();
    const eventHandler = vi.fn();
    const statusHandler = vi.fn();
    subscription.on(eventHandler);
    subscription.onStatusChange(statusHandler);

    expect(source.totalListenerCount()).toBe(DOMAIN_EVENT_TYPES.length + 3);
    source.emit("open");
    subscription.close();
    subscription.close();

    expect(source.close).toHaveBeenCalledOnce();
    expect(source.totalListenerCount()).toBe(0);
    expect(subscription.status).toBe("closed");
    expect(adapter.status).toBe("closed");

    source.emit("JobScored", encodeEnvelope({ jobId: "job-1" }));
    source.emit("heartbeat");
    source.emit("open");
    expect(eventHandler).not.toHaveBeenCalled();
    expect(statusHandler.mock.calls.map(([status]) => status)).toEqual([
      "open",
      "closed",
    ]);
  });

  it("fails closed without constructing a source when EventSource is unavailable", () => {
    vi.stubGlobal("EventSource", undefined);
    const adapter = new SseEventStreamAdapter();

    expect(adapter.status).toBe("connecting");
    const subscription = adapter.subscribe({ tenantId: LOCAL_TENANT });

    expect(FakeEventSource.instances).toHaveLength(0);
    expect(subscription.status).toBe("closed");
    expect(adapter.status).toBe("closed");
    expect(() => subscription.close()).not.toThrow();
  });
});

function encodeEnvelope(payload: Record<string, unknown>): string {
  const tenantId = typeof payload["tenantId"] === "string"
    ? payload["tenantId"]
    : LOCAL_TENANT;
  return JSON.stringify({ tenantId, occurredAt: null, payload });
}
