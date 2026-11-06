import { LocalStorageAdapter } from "../src/shared/adapters/local/LocalStorageAdapter.js";
import { LOCAL_TENANT } from "@jobctrl/domain-types";

import { BrowserHttpAdapter } from "../src/shared/adapters/local/BrowserHttpAdapter.js";
import { BrowserPdfExportAdapter } from "../src/shared/adapters/local/BrowserPdfExportAdapter.js";
import type {
  ClipboardPort,
  DomainEventEnvelope,
  EventStreamPort,
  EventStreamStatus,
  EventStreamSubscription,
  FeatureFlagPort,
  Session,
  SessionPort,
  StoragePort,
  TelemetryPort,
} from "../src/shared/ports/index.js";
import type { Ports } from "../src/shared/providers/PortsProvider.js";

// Optional Storybook documentation uses local ports and explicit illustrative
// data. Product verification belongs to the real Python E2E journeys.

class FakeSubscription implements EventStreamSubscription {
  private readonly handlers = new Set<(event: DomainEventEnvelope) => void>();
  private readonly statusHandlers = new Set<
    (status: EventStreamStatus) => void
  >();
  private current: EventStreamStatus = "open";

  on(handler: (event: DomainEventEnvelope) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onStatusChange(handler: (status: EventStreamStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  get status(): EventStreamStatus {
    return this.current;
  }

  emit(event: DomainEventEnvelope): void {
    for (const handler of this.handlers) handler(event);
  }

  setStatus(next: EventStreamStatus): void {
    this.current = next;
    for (const handler of this.statusHandlers) handler(next);
  }

  close(): void {
    this.handlers.clear();
    this.statusHandlers.clear();
    this.current = "closed";
  }
}

class StoryEventStreamPort implements EventStreamPort {
  status: EventStreamStatus = "open";
  private readonly subscriptions: FakeSubscription[] = [];

  subscribe(_opts: { tenantId: string }): EventStreamSubscription {
    const sub = new FakeSubscription();
    this.subscriptions.push(sub);
    return sub;
  }
}

class InMemoryStoragePort implements StoragePort {
  private readonly map = new Map<string, unknown>();
  get<T = unknown>(key: string): T | null {
    return (this.map.get(key) as T | undefined) ?? null;
  }
  set<T = unknown>(key: string, value: T): void {
    this.map.set(key, value);
  }
  remove(key: string): void {
    this.map.delete(key);
  }
  async transact<T>(
    key: string,
    operation: (current: string | null) => { result: T; write?: string },
    signal?: AbortSignal,
  ): Promise<T> {
    return new LocalStorageAdapter().transact(key, operation, signal);
  }
}

class StorySessionPort implements SessionPort {
  private readonly session: Session = { tenantId: LOCAL_TENANT, userId: null };
  getSession(): Session {
    return this.session;
  }
}

class StoryClipboardPort implements ClipboardPort {
  async write(_text: string): Promise<void> {}
}

class StoryTelemetryPort implements TelemetryPort {
  event(_name: string, _payload?: Record<string, unknown>): void {}
  error(_err: unknown, _payload?: Record<string, unknown>): void {}
  timing(
    _name: string,
    _durationMs: number,
    _payload?: Record<string, unknown>,
  ): void {}
}

class StoryFeatureFlagPort implements FeatureFlagPort {
  get<T extends boolean | number | string>(_key: string, defaultValue: T): T {
    return defaultValue;
  }
}

export function buildStoryPorts(): Ports {
  return {
    http: new BrowserHttpAdapter(),
    eventStream: new StoryEventStreamPort(),
    storage: new InMemoryStoragePort(),
    session: new StorySessionPort(),
    clipboard: new StoryClipboardPort(),
    pdfExport: new BrowserPdfExportAdapter(),
    telemetry: new StoryTelemetryPort(),
    featureFlags: new StoryFeatureFlagPort(),
  };
}
