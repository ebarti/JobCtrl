import type { TenantId } from "@jobhunter/domain-types";

import type {
  DomainEventEnvelope,
  EventStreamPort,
  EventStreamStatus,
  EventStreamSubscription,
} from "../../ports/EventStreamPort.js";

const STREAM_PATH = "/v1/events/stream";
const KNOWN_EVENT_TYPES: ReadonlyArray<string> = [
  "JobDiscovered",
  "JobUpdated",
  "JobDeleted",
  "JobRestored",
  "JobEnriched",
  "EnrichmentFailed",
  "JobScored",
  "ScoreCorrected",
  "ResumeApproved",
  "ResumeFailed",
  "CoverLetterGenerated",
  "PdfRendered",
  "MaterialsExhausted",
  "ApplyRunStarted",
  "ApplyRunEventRecorded",
  "ApplicationSubmitted",
  "ApplicationFailed",
  "StageStarted",
  "StageCompleted",
  "StageFailed",
  "StageExhausted",
  "StageReset",
  "StageBlocked",
  "StageSkipped",
  "StageCanceled",
  "ProfileUpdated",
  "ProfileImported",
];

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

    for (const eventType of KNOWN_EVENT_TYPES) {
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
    const payload = parsePayload(raw.data);
    if (!payload) {
      return;
    }
    const tenantId = readTenantId(payload);
    const envelope: DomainEventEnvelope = {
      eventType,
      tenantId,
      payload,
    };
    for (const handler of this.eventHandlers) {
      handler(envelope);
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

function parsePayload(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readTenantId(payload: Record<string, unknown>): TenantId {
  const candidate = payload["tenantId"];
  return typeof candidate === "string" && candidate.length > 0
    ? (candidate as TenantId)
    : ("local" as TenantId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
