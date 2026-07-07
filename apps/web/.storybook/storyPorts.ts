import { LOCAL_TENANT } from "@jobctrl/domain-types";

import { FetchApiClientAdapter } from "../src/shared/adapters/local/FetchApiClientAdapter.js";
import type {
  ClipboardPort,
  DomainEventEnvelope,
  EventStreamPort,
  EventStreamStatus,
  EventStreamSubscription,
  FeatureFlagPort,
  OpenInOsPort,
  Session,
  SessionPort,
  StoragePort,
  TelemetryPort,
} from "../src/shared/ports/index.js";
import type { Ports } from "../src/shared/providers/PortsProvider.js";

// Storybook-specific port factory. Mirrors `src/test/testPorts.ts` but
// avoids the `vi` import — vitest's expect runtime extends globalThis with
// JEST_MATCHERS_OBJECT and clashes with Storybook 10's bundled expect,
// killing every iframe with `Cannot read properties of undefined
// (reading 'customEqualityTesters')`.

class FakeSubscription implements EventStreamSubscription {
  private readonly handlers = new Set<(event: DomainEventEnvelope) => void>();
  private readonly statusHandlers = new Set<(status: EventStreamStatus) => void>();
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

class StoryOpenInOsPort implements OpenInOsPort {
  async open(artifactId: string) {
    return {
      ok: true as const,
      artifact: {
        artifactId,
        jobKey: "job-1",
        title: "Sample",
        company: "Acme",
        type: "resume_pdf",
        status: "approved",
        localPath: `/tmp/${artifactId}.pdf`,
        createdAt: null,
        sizeBytes: null,
        size: "0",
      },
      opened: true as const,
      path: `/tmp/${artifactId}.pdf`,
    };
  }
}

class StoryTelemetryPort implements TelemetryPort {
  event(_name: string, _payload?: Record<string, unknown>): void {}
  error(_err: unknown, _payload?: Record<string, unknown>): void {}
  timing(_name: string, _durationMs: number, _payload?: Record<string, unknown>): void {}
}

class StoryFeatureFlagPort implements FeatureFlagPort {
  get<T extends boolean | number | string>(_key: string, defaultValue: T): T {
    return defaultValue;
  }
}

export function buildStoryPorts(): Ports {
  return {
    api: new FetchApiClientAdapter(),
    eventStream: new StoryEventStreamPort(),
    storage: new InMemoryStoragePort(),
    session: new StorySessionPort(),
    clipboard: new StoryClipboardPort(),
    openInOs: new StoryOpenInOsPort(),
    telemetry: new StoryTelemetryPort(),
    featureFlags: new StoryFeatureFlagPort(),
  };
}
