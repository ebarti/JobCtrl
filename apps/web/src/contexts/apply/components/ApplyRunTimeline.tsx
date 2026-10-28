import type { JSX } from "react";
import { useMemo } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";

import { applyRunsKeys } from "../../operations/applyRunsKeys.js";
import { Empty } from "../../../shared/ui/empty.js";
import { formatDateTime } from "../../../shared/lib/formatters.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import type { StatusTagTone } from "../../../shared/ui/status-tokens.js";
import {
  normalizeApplyRunEventEntry,
  type ApplyRunWithEvents,
} from "../selectors/applyRunSelectors.js";

const EMPTY_EVENTS: readonly unknown[] = [];

export interface ApplyRunTimelineProps {
  runId: string;
  events?: readonly unknown[];
  applyEvents?: readonly unknown[];
}

function eventLabel(type: string): string {
  return type
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/\s+/g, " ");
}

export function applyRunEventLevelTone(level: string): StatusTagTone {
  const normalized = level.toLowerCase();
  if (normalized === "error") return "danger";
  if (normalized === "warn" || normalized === "warning") return "warn";
  if (normalized === "debug") return "muted";
  return "info";
}

export function ApplyRunTimeline({ runId, events = EMPTY_EVENTS, applyEvents = EMPTY_EVENTS }: ApplyRunTimelineProps): JSX.Element {
  const tenantId = useTenantId();
  const queryKey = useMemo(() => applyRunsKeys.detail(tenantId, runId), [runId, tenantId]);
  const { data } = useQuery<ApplyRunWithEvents>({
    queryKey,
    queryFn: skipToken,
    enabled: false,
    initialData: { events: [] },
    staleTime: Number.POSITIVE_INFINITY,
  });

  const timeline = useMemo(() => {
    const workflow = events.map(normalizeApplyRunEventEntry);
    const persisted = applyEvents.map(normalizeApplyRunEventEntry);
    const knownRunEvents = new Set(persisted.flatMap((event) => event.runEventId === undefined ? [] : [event.runEventId]));
    const live = (data?.events ?? []).map(normalizeApplyRunEventEntry).filter((event) => {
      if (event.runEventId === undefined) return true;
      if (knownRunEvents.has(event.runEventId)) return false;
      knownRunEvents.add(event.runEventId);
      return true;
    });
    return [...workflow, ...persisted, ...live]
      .map((event, index) => ({ event, index, timestamp: event.at ? Date.parse(event.at) : Number.NaN }))
      .sort((left, right) => {
        const leftTime = Number.isFinite(left.timestamp) ? left.timestamp : Infinity;
        const rightTime = Number.isFinite(right.timestamp) ? right.timestamp : Infinity;
        return leftTime - rightTime || left.index - right.index;
      })
      .map(({ event }) => event);
  }, [events, applyEvents, data?.events]);

  return (
    <div className="apply-run-timeline" data-run-id={runId}>
      {timeline.length === 0 ? <Empty title="No timeline events recorded for this run." /> : null}
      {timeline.length > 0 ? (
        <ol className="apply-run-timeline-list" aria-label="Apply run timeline">
          {timeline.map((event, index) => (
            <li
              className={`apply-run-timeline-event tone-${applyRunEventLevelTone(event.level)}`}
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
