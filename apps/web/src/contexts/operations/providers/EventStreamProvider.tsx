import { DOMAIN_EVENT_TYPES } from "@jobctrl/domain-types";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { DomainEventEnvelope, EventStreamStatus } from "../../../shared/ports/EventStreamPort.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { applyRunsKeys } from "../applyRunsKeys.js";
import { useInvalidationRouter } from "../hooks/useInvalidationRouter.js";
import type { DomainEventUnion as KnownDomainEvent } from "@jobctrl/domain-types";
import type { KnownDomainEventType } from "../types.js";

interface EventStreamContextValue {
  readonly status: EventStreamStatus;
}

const EventStreamContext = createContext<EventStreamContextValue | null>(null);

const KNOWN_EVENT_TYPES: ReadonlySet<KnownDomainEventType> = new Set<KnownDomainEventType>(
  DOMAIN_EVENT_TYPES,
);

function isKnownDomainEvent(envelope: DomainEventEnvelope): envelope is DomainEventEnvelope & {
  eventType: KnownDomainEventType;
} {
  return KNOWN_EVENT_TYPES.has(envelope.eventType as KnownDomainEventType);
}

export function EventStreamProvider({ children }: { children: ReactNode }) {
  const tenantId = useTenantId();
  const { eventStream, telemetry } = usePorts();
  const queryClient = useQueryClient();
  const router = useInvalidationRouter();
  const [status, setStatus] = useState<EventStreamStatus>(eventStream.status);
  useEffect(() => {
    const subscription = eventStream.subscribe({ tenantId });
    setStatus(subscription.status);
    let previousStatus = subscription.status;
    let active = true;
    const pendingReads = new Set<string>();

    const reconcile = () => {
      const tenant = { queryKey: ["tenant", tenantId] as const };
      // Apply-run detail is a disabled, locally patched timeline with no
      // canonical queryFn. Preserve live entries while refreshing the
      // workflow-run read that supplies their persisted baseline.
      const timelinePrefix = applyRunsKeys.details(tenantId);
      const isTimeline = (key: readonly unknown[]) =>
        timelinePrefix.every((segment, index) => key[index] === segment);
      const unfinished = queryClient.getQueryCache().findAll({
        ...tenant,
        predicate: (query) => !isTimeline(query.queryKey)
          && query.state.data === undefined && query.promise !== undefined,
      });
      const unfinishedSet = new Set(unfinished);
      // Invalidation normally reuses a first fetch without data, and its
      // eventual result clears the invalidation. Let each such read settle
      // (route loaders may be awaiting it), then invalidate it independently.
      // Already-cached reads can be reconciled immediately.
      void queryClient.invalidateQueries({
        ...tenant,
        predicate: (query) => !isTimeline(query.queryKey) && !unfinishedSet.has(query),
      });
      for (const query of unfinished) {
        if (pendingReads.has(query.queryHash)) continue;
        pendingReads.add(query.queryHash);
        const afterRead = () => {
          pendingReads.delete(query.queryHash);
          if (active && queryClient.getQueryCache().get(query.queryHash) === query) {
            void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true });
          }
        };
        void query.promise?.then(afterRead, afterRead);
      }
    };

    const offStatus = subscription.onStatusChange((next) => {
      setStatus(next);
      if (next === "open" && previousStatus !== "open") {
        reconcile();
      }
      previousStatus = next;
    });
    const offEvent = subscription.on((envelope) => {
      if (envelope.tenantId !== tenantId) return;
      if (!isKnownDomainEvent(envelope)) {
        telemetry.event("event-stream.unknown-event", {
          eventType: envelope.eventType,
        });
        return;
      }
      router.handle(envelope as unknown as KnownDomainEvent, queryClient);
    });
    // Ports that are already open on subscription have the same read/stream
    // gap as an asynchronous first connection.
    if (previousStatus === "open") {
      reconcile();
    }
    return () => {
      active = false;
      offEvent();
      offStatus();
      subscription.close();
    };
  }, [tenantId, eventStream, queryClient, router, telemetry]);

  const value = useMemo<EventStreamContextValue>(() => ({ status }), [status]);
  return <EventStreamContext.Provider value={value}>{children}</EventStreamContext.Provider>;
}

export function useEventStreamStatus(): EventStreamStatus {
  const ctx = useContext(EventStreamContext);
  if (!ctx) {
    throw new Error("useEventStreamStatus must be called within <EventStreamProvider>.");
  }
  return ctx.status;
}
