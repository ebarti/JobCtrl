import type { DomainEventUnion, TenantId } from "@jobctrl/domain-types";

import type { DemoWorkspaceNotification } from "./contracts.js";
import { DemoWorkspaceRepository } from "./DemoWorkspaceRepository.js";
import type {
  DomainEventEnvelope,
  EventStreamPort,
  EventStreamStatus,
  EventStreamSubscription,
} from "../../shared/ports/EventStreamPort.js";

/**
 * Serially drains the committed workspace domain-event log through the normal
 * EventStreamPort. Reset, revision gaps, and bounded-log loss are represented
 * as closed -> open recovery, which activates the existing provider backstop.
 */
export class DemoWorkspaceEventStreamAdapter implements EventStreamPort {
  private currentStatus: EventStreamStatus = "connecting";

  constructor(private readonly workspace: DemoWorkspaceRepository) {}

  get status(): EventStreamStatus {
    return this.currentStatus;
  }

  subscribe({ tenantId }: { tenantId: TenantId }): EventStreamSubscription {
    return new DemoWorkspaceSubscription(this.workspace, tenantId, (status) => {
      this.currentStatus = status;
    });
  }
}

class DemoWorkspaceSubscription implements EventStreamSubscription {
  private readonly eventHandlers = new Set<
    (event: DomainEventEnvelope) => void
  >();
  private readonly statusHandlers = new Set<
    (status: EventStreamStatus) => void
  >();
  private statusValue: EventStreamStatus = "connecting";
  private closed = false;
  private lastDeliveredSequence = 0;
  private readonly stop: () => void;
  private notificationQueue: Promise<void>;

  constructor(
    private readonly workspace: DemoWorkspaceRepository,
    private readonly tenantId: TenantId,
    private readonly setParentStatus: (status: EventStreamStatus) => void,
  ) {
    this.notificationQueue = this.open();
    this.stop = workspace.subscribe((notification) => {
      this.notificationQueue = this.notificationQueue
        .then(() => this.handleNotification(notification))
        .catch(() => this.setStatus("closed"));
    });
  }

  get status(): EventStreamStatus {
    return this.statusValue;
  }

  on(handler: (event: DomainEventEnvelope) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onStatusChange(handler: (status: EventStreamStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stop();
    this.setStatus("closed");
  }

  private async open(): Promise<void> {
    try {
      const initialization = await this.workspace.initialize();
      if (initialization.kind === "upgrade_required") {
        this.setStatus("closed");
        return;
      }
      this.lastDeliveredSequence = initialization.snapshot.lastEventSequence;
      if (!this.closed) {
        this.setStatus("open");
      }
    } catch {
      if (!this.closed) {
        this.setStatus("closed");
      }
    }
  }

  private async handleNotification(
    notification: DemoWorkspaceNotification,
  ): Promise<void> {
    if (this.closed) {
      return;
    }
    if (notification.kind === "reset" || notification.kind === "resync") {
      this.lastDeliveredSequence = notification.lastEventSequence;
      this.cycleConnection();
      return;
    }
    if (notification.lastEventSequence <= this.lastDeliveredSequence) {
      return;
    }

    const result = await this.workspace.readEventsForNotification(
      notification,
      this.lastDeliveredSequence,
    );
    if (result.kind === "event_log_lost") {
      this.lastDeliveredSequence = notification.lastEventSequence;
      this.cycleConnection();
      return;
    }
    for (const event of result.events) {
      if (this.closed) {
        return;
      }
      this.emit(event);
    }
    this.lastDeliveredSequence = notification.lastEventSequence;
  }

  private emit(event: DomainEventUnion): void {
    if (event.tenantId !== this.tenantId) {
      return;
    }
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  private cycleConnection(): void {
    this.setStatus("closed");
    if (!this.closed) {
      this.setStatus("open");
    }
  }

  private setStatus(next: EventStreamStatus): void {
    if (this.statusValue === next) {
      return;
    }
    this.statusValue = next;
    this.setParentStatus(next);
    for (const handler of this.statusHandlers) {
      handler(next);
    }
  }
}
