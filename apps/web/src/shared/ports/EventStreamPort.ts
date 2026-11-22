import type { TenantId } from "@jobctrl/domain-types";

export type EventStreamStatus = "connecting" | "open" | "closed" | "workspace_changed";

export interface DomainEventEnvelope {
  readonly eventType: string;
  readonly tenantId: TenantId;
  readonly eventId?: string;
  readonly feature?: string;
  readonly aggregateId?: string | null;
  readonly occurredAt?: string | null;
  readonly payload: unknown;
}

export interface EventStreamSubscription {
  on(handler: (event: DomainEventEnvelope) => void): () => void;
  /** A received frame could not be interpreted; consumers must reconcile. */
  onInvalid?(handler: () => void): () => void;
  readonly status: EventStreamStatus;
  onStatusChange(callback: (status: EventStreamStatus) => void): () => void;
  close(): void;
}

export interface EventStreamPort {
  subscribe(opts: { tenantId: TenantId }): EventStreamSubscription;
  readonly status: EventStreamStatus;
}
