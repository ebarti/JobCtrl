import type { ActivityEventSummary } from "../../contexts/operations/types.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import type { DataGridColumn } from "../../shared/ui/filterable-data-grid.js";
import { activityLevelTone } from "./activity-tone.js";

function activityContext(activity: ActivityEventSummary): string {
  if (activity.title) {
    return `${activity.title} · ${activity.company ?? "Unknown"}`;
  }
  return activity.jobKey ?? `event ${activity.eventId}`;
}

export const activityColumns: Array<DataGridColumn<ActivityEventSummary>> = [
  {
    id: "level",
    label: "Level",
    className: "activity-level-cell",
    headerClassName: "activity-level-cell",
    width: 74,
    minWidth: 62,
    sortable: true,
    render: (activity) => (
      <span className={`tag ${activityLevelTone(activity.level)}`}>
        {activity.level}
      </span>
    ),
  },
  {
    id: "stage",
    label: "Stage",
    className: "activity-stage-cell",
    headerClassName: "activity-stage-cell",
    width: 74,
    minWidth: 62,
    sortable: true,
    render: (activity) => <span className="stage-pill">{activity.stage}</span>,
  },
  {
    id: "message",
    label: "Activity",
    className: "activity-message-cell",
    headerClassName: "activity-message-cell",
    width: 542,
    minWidth: 260,
    rowHeader: true,
    sortable: true,
    render: (activity) => (
      <span className="activity-main">
        <b>{activity.message}</b>
        <span>{activityContext(activity)}</span>
      </span>
    ),
  },
  {
    id: "event_type",
    label: "Event",
    className: "activity-event-cell",
    headerClassName: "activity-event-cell",
    width: 120,
    minWidth: 92,
    sortable: true,
    render: (activity) => <span className="mono">{activity.eventType}</span>,
  },
  {
    id: "occurred_at",
    label: "When",
    className: "mono activity-time-cell",
    headerClassName: "activity-time-cell",
    width: 170,
    minWidth: 140,
    sortable: true,
    render: (activity) => (
      <span title={`${formatDateTime(activity.at)} #${activity.eventId}`}>
        {formatDateTime(activity.at)} #{activity.eventId}
      </span>
    ),
  },
];
