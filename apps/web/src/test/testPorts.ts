import { LOCAL_TENANT } from "@jobhunter/domain-types";
import { vi } from "vitest";

import { FetchApiClientAdapter } from "../shared/adapters/local/FetchApiClientAdapter.js";
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
} from "../shared/ports/index.js";
import type { Ports } from "../shared/providers/PortsProvider.js";
import {
  makeArtifactDetail,
  makeArtifactsPage,
  sampleArtifact,
  sampleExtensionCapabilityTokenResponse,
  sampleResumeTemplateListResponse,
} from "./fixtures/projections.js";

const sampleDiscoverySourceRegistry = {
  ok: true as const,
  sources: [
    {
      sourceId: "jobspy:linkedin",
      kind: "broad_board" as const,
      displayName: "LinkedIn",
      owner: "system" as const,
      priority: "standard" as const,
      state: "active" as const,
      policyId: "jobspy_default",
      recommendedState: "normal" as const,
      lastRunId: null,
      lastRunCompletedAt: null,
      lastErrorClass: null,
      consecutiveFailures: 0,
      observedJobs: 0,
      newJobs: 0,
      duplicateRate: null,
      activeVerificationRate: null,
      fullDescriptionSuccessRate: null,
      applyUrlSuccessRate: null,
      politeness: {
        robotsDisallowedCount: 0,
        rateLimitedCount: 3,
        budgetExhaustedCount: 0,
        lastBlockedReason: "rate_limited" as const,
        lastBlockedAt: "2026-05-16T10:00:00+00:00",
      },
      qualityTrend: "unknown" as const,
    },
  ],
};

export class FakeEventStreamPort implements EventStreamPort {
  status: EventStreamStatus = "open";
  readonly subscriptions: FakeSubscription[] = [];

  subscribe(_opts: { tenantId: string }): EventStreamSubscription {
    const sub = new FakeSubscription();
    this.subscriptions.push(sub);
    return sub;
  }

  emit(event: DomainEventEnvelope): void {
    for (const sub of this.subscriptions) {
      sub.emit(event);
    }
  }

  setStatus(next: EventStreamStatus): void {
    this.status = next;
    for (const sub of this.subscriptions) {
      sub.setStatus(next);
    }
  }
}

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
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  setStatus(next: EventStreamStatus): void {
    this.current = next;
    for (const handler of this.statusHandlers) {
      handler(next);
    }
  }

  close(): void {
    this.handlers.clear();
    this.statusHandlers.clear();
    this.current = "closed";
  }
}

export class InMemoryStoragePort implements StoragePort {
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

export class FakeSessionPort implements SessionPort {
  constructor(private readonly session: Session = { tenantId: LOCAL_TENANT, userId: null }) {}
  getSession(): Session {
    return this.session;
  }
}

export class FakeClipboardPort implements ClipboardPort {
  readonly write = vi.fn(async (_text: string): Promise<void> => {});
}

export class FakeOpenInOsPort implements OpenInOsPort {
  readonly open = vi.fn(async (artifactId: string) => ({
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
  }));
}

export class FakeTelemetryPort implements TelemetryPort {
  readonly event = vi.fn();
  readonly error = vi.fn();
  readonly timing = vi.fn();
}

export class FakeFeatureFlagPort implements FeatureFlagPort {
  get<T extends boolean | number | string>(_key: string, defaultValue: T): T {
    return defaultValue;
  }
}

export interface BuildTestPortsOptions {
  readonly api?: Partial<Ports["api"]>;
  readonly eventStream?: EventStreamPort;
}

export function buildTestPorts(overrides: BuildTestPortsOptions = {}): Ports {
  const baseApi = new FetchApiClientAdapter();
  const templateApiDefaults: Partial<Ports["api"]> = {
    artifacts: vi.fn(async () => makeArtifactsPage()),
    artifact: vi.fn(async (artifactId: string) =>
      makeArtifactDetail({
        ...sampleArtifact,
        artifactId,
      }),
    ),
    discoverySources: vi.fn(async () => sampleDiscoverySourceRegistry),
    resumeTemplates: vi.fn(async () => sampleResumeTemplateListResponse),
    saveResumeTemplate: vi.fn(async (body) => ({
      ok: true as const,
      template: {
        ...sampleResumeTemplateListResponse.templates[0]!,
        templateId: body.templateId ?? "custom-template-1",
        displayName: body.displayName,
        builtIn: false,
        activeVersion: {
          ...sampleResumeTemplateListResponse.templates[0]!.activeVersion,
          templateId: body.templateId ?? "custom-template-1",
          versionId: `${body.templateId ?? "custom-template-1"}:v2`,
          versionNumber: 2,
          displayName: body.displayName,
          theme: body.theme,
          layout: body.layout ?? {},
        },
      },
    })),
    setDefaultResumeTemplate: vi.fn(async (body) => ({
      ok: true as const,
      defaultTemplate: {
        ...sampleResumeTemplateListResponse.builtInDefault,
        templateId: body.templateId,
        templateVersionId: body.versionId ?? sampleResumeTemplateListResponse.builtInDefault.templateVersionId,
        assignmentSource: "profile_default" as const,
      },
    })),
    setJobResumeTemplate: vi.fn(async (jobKey, body) => ({
      ok: true as const,
      jobKey,
      effectiveTemplate: {
        ...sampleResumeTemplateListResponse.builtInDefault,
        templateId: body.templateId ?? sampleResumeTemplateListResponse.builtInDefault.templateId,
        templateVersionId: body.versionId ?? sampleResumeTemplateListResponse.builtInDefault.templateVersionId,
        assignmentSource: body.templateId ? ("job_override" as const) : ("built_in" as const),
      },
      overrideTemplate: body.templateId
        ? {
            ...sampleResumeTemplateListResponse.builtInDefault,
            templateId: body.templateId,
            templateVersionId: body.versionId ?? sampleResumeTemplateListResponse.builtInDefault.templateVersionId,
            assignmentSource: "job_override" as const,
          }
        : null,
      templateState: null,
    })),
    ensureCurrentResumeMaterials: vi.fn(async (jobKey) => ({
      ok: true as const,
      jobKey,
      status: "not_required" as const,
      templateState: null,
      attempt: null,
      generation: null,
      message: "Resume materials already use the effective template.",
    })),
    extensionCapabilityToken: vi.fn(async () => sampleExtensionCapabilityTokenResponse),
    rotateExtensionCapabilityToken: vi.fn(async () => ({
      ...sampleExtensionCapabilityTokenResponse,
      token: "jh_ext_rotated_token_123456789012345678901234567",
      created: true,
    })),
    sampleDataStatus: vi.fn(async () => ({
      ok: true as const,
      state: "blocked" as const,
      dbExists: true,
      canLoad: false,
      canClear: false,
      jobCount: 1,
      sampleJobCount: 0,
      loadedAt: null,
      sampleJobs: [],
      message: "Sample data can only be loaded into an empty workspace.",
    })),
    loadSampleData: vi.fn(async () => ({
      ok: true as const,
      loaded: true,
      cleared: false,
      status: {
        ok: true as const,
        state: "loaded" as const,
        dbExists: true,
        canLoad: false,
        canClear: true,
        jobCount: 2,
        sampleJobCount: 2,
        loadedAt: "2026-07-06T10:00:00.000Z",
        sampleJobs: [],
        message: "Sample data is loaded. Clear it before starting real job discovery.",
      },
      message: "Sample data loaded.",
    })),
    clearSampleData: vi.fn(async () => ({
      ok: true as const,
      loaded: false,
      cleared: true,
      status: {
        ok: true as const,
        state: "empty" as const,
        dbExists: true,
        canLoad: true,
        canClear: false,
        jobCount: 0,
        sampleJobCount: 0,
        loadedAt: null,
        sampleJobs: [],
        message: "This empty workspace can load JobHunter sample data.",
      },
      message: "Sample data cleared.",
    })),
    sampleDataTtfvProbe: vi.fn(async () => ({
      ok: true as const,
      mode: "synthetic_sample" as const,
      checkedAt: "2026-07-06T10:00:00.000Z",
      ttfv1: { passed: false, job: null },
      ttfv2: { passed: false, job: null, artifactId: null, artifactBytes: null },
    })),
  };
  const api = overrides.api
    ? Object.assign(Object.create(Object.getPrototypeOf(baseApi)), baseApi, templateApiDefaults, overrides.api)
    : Object.assign(Object.create(Object.getPrototypeOf(baseApi)), baseApi, templateApiDefaults);
  return {
    api,
    eventStream: overrides.eventStream ?? new FakeEventStreamPort(),
    storage: new InMemoryStoragePort(),
    session: new FakeSessionPort(),
    clipboard: new FakeClipboardPort(),
    openInOs: new FakeOpenInOsPort(),
    telemetry: new FakeTelemetryPort(),
    featureFlags: new FakeFeatureFlagPort(),
  };
}
