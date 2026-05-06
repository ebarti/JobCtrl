import type { TenantId } from "@jobhunter/domain-types";

export type EventStreamStatus = "connecting" | "open" | "closed";

export interface DomainEventEnvelope {
  readonly eventType: string;
  readonly tenantId: TenantId;
  readonly payload: unknown;
}

export interface EventStreamSubscription {
  on(handler: (event: DomainEventEnvelope) => void): () => void;
  readonly status: EventStreamStatus;
  onStatusChange(callback: (status: EventStreamStatus) => void): () => void;
  close(): void;
}

export interface EventStreamPort {
  subscribe(opts: { tenantId: TenantId }): EventStreamSubscription;
  readonly status: EventStreamStatus;
}
