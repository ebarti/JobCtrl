import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { invalidateQueriesWithOptimisticOwnership } from "../lib/createOptimisticMutation.js";
import type { EventStreamStatus } from "../ports/EventStreamPort.js";
import type { FeatureEventHandler } from "../ports/FeatureEvents.js";
import { usePorts } from "./PortsProvider.js";
import { useTenantId } from "./TenantProvider.js";

interface EventStreamContextValue { readonly status: EventStreamStatus }
const EventStreamContext = createContext<EventStreamContextValue | null>(null);
const NO_HANDLERS: readonly FeatureEventHandler[] = [];

export function EventStreamProvider({ children, handlers = NO_HANDLERS }: {
  children: ReactNode;
  handlers?: readonly FeatureEventHandler[];
}) {
  const tenantId = useTenantId();
  const { eventStream, telemetry } = usePorts();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<EventStreamStatus>(eventStream.status);
  useEffect(() => {
    const subscription = eventStream.subscribe({ tenantId });
    setStatus(subscription.status);
    let previousStatus = subscription.status;
    const reconcile = () => {
      // Preserve in-flight optimistic patches and reconcile initial reads
      // after they settle, including route-loader reads.
      void invalidateQueriesWithOptimisticOwnership(queryClient, ["tenant", tenantId]);
    };
    const offStatus = subscription.onStatusChange((next) => {
      setStatus(next);
      if (next === "open" && previousStatus !== "open") reconcile();
      previousStatus = next;
    });
    const offEvent = subscription.on((event) => {
      if (event.tenantId !== tenantId) return;
      const owners = handlers.filter((handler) => handler.eventTypes.includes(event.eventType));
      const observers = handlers.filter((handler) => handler.eventTypes.includes("*"));
      if (!owners.length) {
        telemetry.event("event-stream.unhandled-event", { eventType: event.eventType });
        reconcile();
      }
      try {
        for (const owner of [...owners, ...observers]) owner.handle(event, queryClient);
      } catch {
        telemetry.event("event-stream.invalidation-failed", { eventType: event.eventType });
        reconcile();
      }
    });
    const offInvalid = subscription.onInvalid?.(() => {
      telemetry.event("event-stream.invalid-frame");
      reconcile();
    });
    if (previousStatus === "open") reconcile();
    return () => { offInvalid?.(); offEvent(); offStatus(); subscription.close(); };
  }, [tenantId, eventStream, queryClient, telemetry, handlers]);
  const value = useMemo<EventStreamContextValue>(() => ({ status }), [status]);
  return <EventStreamContext.Provider value={value}>{children}</EventStreamContext.Provider>;
}

export function useEventStreamStatus(): EventStreamStatus {
  const context = useContext(EventStreamContext);
  if (!context) throw new Error("useEventStreamStatus must be called within <EventStreamProvider>.");
  return context.status;
}
