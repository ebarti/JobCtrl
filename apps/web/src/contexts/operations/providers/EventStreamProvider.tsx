import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { DomainEventEnvelope, EventStreamStatus } from "../../../shared/ports/EventStreamPort.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { useInvalidationRouter } from "../hooks/useInvalidationRouter.js";
import type { KnownDomainEvent, KnownDomainEventType } from "../types.js";

interface EventStreamContextValue {
  readonly status: EventStreamStatus;
}

const EventStreamContext = createContext<EventStreamContextValue | null>(null);

const KNOWN_EVENT_TYPES: ReadonlySet<KnownDomainEventType> = new Set<KnownDomainEventType>([
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
]);

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
  // §7.7 backstop is "on reconnect" — fire once we've previously been
  // open and recover to open after a drop.  The first
  // connecting→open of the session is the initial connection, not a
  // reconnection, and must not invalidate.
  const hadOpenRef = useRef(false);

  useEffect(() => {
    const subscription = eventStream.subscribe({ tenantId });
    setStatus(subscription.status);
    // Reset on every (re-)subscription so a tenant switch behaves like
    // a fresh first-connect rather than a reconnect.
    hadOpenRef.current = subscription.status === "open";

    const offStatus = subscription.onStatusChange((next) => {
      setStatus(next);
      if (next !== "open") {
        return;
      }
      if (hadOpenRef.current) {
        // A closed→open recovery may have missed events the
        // EventSource couldn't resume via Last-Event-ID.  One-shot
        // full invalidation pulls the cache back into line.
        void queryClient.invalidateQueries();
      } else {
        hadOpenRef.current = true;
      }
    });
    const offEvent = subscription.on((envelope) => {
      if (!isKnownDomainEvent(envelope)) {
        telemetry.event("event-stream.unknown-event", {
          eventType: envelope.eventType,
        });
        return;
      }
      router.handle(envelope as unknown as KnownDomainEvent, queryClient);
    });
    return () => {
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
