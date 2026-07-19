import type { ActivityEventSummary } from "../../contexts/operations/types.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import type { DataGridColumn } from "../../shared/ui/filterable-data-grid.js";
import { RelativeTime } from "../../shared/ui/relative-time.js";
import { StatusBadge } from "../../shared/ui/status-badge.js";
import { ActivityIdentifier } from "./ActivityIdentifier.js";
import { activityLevelTone } from "./activity-tone.js";

function activityContext(activity: ActivityEventSummary): string {
  if (activity.title) {
    return `${activity.title} · ${activity.company ?? "Unknown company"}`;
  }
  return activity.jobKey ?? "No job context";
}

export function ActivityMobileRow({
  activity,
}: {
  readonly activity: ActivityEventSummary;
}) {
  return (
    <details className="activity-mobile-row" data-row-activation-ignore>
      <summary>
        <StatusBadge tone={activityLevelTone(activity.level)}>
          {activity.level}
        </StatusBadge>
        <span className="activity-mobile-row__summary">
          <span data-typography="strong-body">{activity.message}</span>
          <span data-typography="metadata">
            <RelativeTime value={activity.at} />
          </span>
        </span>
      </summary>
      <dl className="activity-mobile-row__details">
        <div>
          <dt data-typography="label">Stage</dt>
          <dd data-typography="body">{activity.stage}</dd>
        </div>
        <div>
          <dt data-typography="label">Event type</dt>
          <dd>
            <code data-typography="code">{activity.eventType}</code>
          </dd>
        </div>
        <div>
          <dt data-typography="label">Context</dt>
          <dd data-typography="body">{activityContext(activity)}</dd>
        </div>
        <div>
          <dt data-typography="label">Event ID</dt>
          <dd>
            <ActivityIdentifier eventId={activity.eventId} />
          </dd>
        </div>
      </dl>
    </details>
  );
}

export const activityColumns: Array<DataGridColumn<ActivityEventSummary>> = [
  {
    id: "level",
    label: "Level",
    className: "activity-level-cell",
    headerClassName: "activity-level-cell",
    width: 82,
    minWidth: 72,
    sortable: true,
    getFilterValue: (activity) => activity.level,
    render: (activity) => (
      <StatusBadge tone={activityLevelTone(activity.level)}>
        {activity.level}
      </StatusBadge>
    ),
  },
  {
    id: "stage",
    label: "Stage",
    className: "activity-stage-cell",
    headerClassName: "activity-stage-cell",
    width: 94,
    minWidth: 82,
    sortable: true,
    getFilterValue: (activity) => activity.stage,
    render: (activity) => <span className="stage-pill">{activity.stage}</span>,
  },
  {
    id: "message",
    label: "Summary",
    className: "activity-message-cell",
    headerClassName: "activity-message-cell",
    width: 400,
    minWidth: 260,
    rowHeader: true,
    sortable: true,
    getFilterValue: (activity) => activity.message,
    getFilterSearchValue: (activity) =>
      `${activity.message} ${activityContext(activity)}`,
    render: (activity) => (
      <span className="activity-main">
        <span data-typography="strong-body">{activity.message}</span>
        <span data-typography="metadata">{activityContext(activity)}</span>
      </span>
    ),
  },
  {
    id: "event_type",
    label: "Event type",
    className: "activity-event-cell",
    headerClassName: "activity-event-cell",
    width: 150,
    minWidth: 112,
    sortable: true,
    getFilterValue: (activity) => activity.eventType,
    render: (activity) => (
      <code className="mono" data-typography="code">
        {activity.eventType}
      </code>
    ),
  },
  {
    id: "occurred_at",
    label: "Occurred",
    className: "activity-time-cell",
    headerClassName: "activity-time-cell",
    width: 150,
    minWidth: 132,
    sortable: true,
    getFilterValue: (activity) => activity.at ?? "-",
    render: (activity) => (
      <span title={formatDateTime(activity.at)} data-typography="metadata">
        <RelativeTime value={activity.at} />
      </span>
    ),
  },
  {
    id: "event_id",
    label: "Event ID",
    className: "activity-id-cell",
    headerClassName: "activity-id-cell",
    width: 150,
    minWidth: 120,
    getFilterValue: (activity) => activity.eventId,
    render: (activity) => <ActivityIdentifier eventId={activity.eventId} />,
  },
];
