import type { JSX } from "react";
import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { applyRunsKeys } from "../../operations/applyRunsKeys.js";
import { Empty } from "../../../shared/ui/empty.js";
import { formatDateTime } from "../../../shared/lib/formatters.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import {
  normalizeApplyRunEventEntry,
  type ApplyRunWithEvents,
} from "../selectors/applyRunSelectors.js";

const EMPTY_EVENTS: readonly unknown[] = [];

export interface ApplyRunTimelineProps {
  runId: string;
  events?: readonly unknown[];
}

function eventLabel(type: string): string {
  return type
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/\s+/g, " ");
}

function levelTone(level: string): string {
  const normalized = level.toLowerCase();
  if (normalized === "error") return "danger";
  if (normalized === "warn" || normalized === "warning") return "warn";
  if (normalized === "debug") return "muted";
  return "info";
}

export function ApplyRunTimeline({ runId, events = EMPTY_EVENTS }: ApplyRunTimelineProps): JSX.Element {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => applyRunsKeys.detail(tenantId, runId), [runId, tenantId]);
  const initialEvents = useMemo(
    () => events.map((event) => normalizeApplyRunEventEntry(event)),
    [events],
  );
  const { data } = useQuery<ApplyRunWithEvents>({
    queryKey,
    queryFn: async () => ({ events: initialEvents }),
    initialData: { events: initialEvents },
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    queryClient.setQueryData<ApplyRunWithEvents>(queryKey, (current) => {
      const currentEvents = current?.events ?? [];
      if (currentEvents.length >= initialEvents.length) {
        return current ?? { events: currentEvents };
      }
      return { ...(current ?? {}), events: initialEvents };
    });
  }, [initialEvents, queryClient, queryKey]);

  const timeline = useMemo(
    () => (data?.events ?? []).map((event) => normalizeApplyRunEventEntry(event)),
    [data?.events],
  );

  return (
    <div className="apply-run-timeline" data-run-id={runId}>
      {timeline.length === 0 ? <Empty title="No timeline events recorded for this run." /> : null}
      {timeline.length > 0 ? (
        <ol className="apply-run-timeline-list" aria-label="Apply run timeline">
          {timeline.map((event, index) => (
            <li
              className={`apply-run-timeline-event tone-${levelTone(event.level)}`}
              key={`${event.at ?? "no-time"}-${event.type}-${index}`}
            >
              <span className="apply-run-timeline-marker" aria-hidden="true" />
              <span className="apply-run-timeline-body">
                <span className="apply-run-timeline-head">
                  <strong>{eventLabel(event.type)}</strong>
                  {event.at ? <time dateTime={event.at}>{formatDateTime(event.at)}</time> : null}
                </span>
                {event.message ? <span className="apply-run-timeline-message">{event.message}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
