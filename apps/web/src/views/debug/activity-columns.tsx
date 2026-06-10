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
    sortable: true,
    render: (activity) => <span className="stage-pill">{activity.stage}</span>,
  },
  {
    id: "message",
    label: "Activity",
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
    sortable: true,
    render: (activity) => <span className="mono">{activity.eventType}</span>,
  },
  {
    id: "occurred_at",
    label: "When",
    className: "mono activity-time-cell",
    sortable: true,
    render: (activity) => (
      <span title={`${formatDateTime(activity.at)} #${activity.eventId}`}>
        {formatDateTime(activity.at)} #{activity.eventId}
      </span>
    ),
  },
];
