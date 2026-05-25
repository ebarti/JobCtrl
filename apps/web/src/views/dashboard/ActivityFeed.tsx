import { useNavigate } from "@tanstack/react-router";

import type { DashboardSummary } from "../../contexts/operations/types.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import {
  FilterableDataGrid,
  type DataGridColumn,
} from "../../shared/ui/filterable-data-grid.js";

export interface ActivityFeedProps {
  summary: DashboardSummary;
}

type ActivityItem = DashboardSummary["activity"][number];

function activityContext(activity: ActivityItem): string {
  if (activity.title) {
    return `${activity.title} · ${activity.company ?? "Unknown"}`;
  }
  return activity.jobKey ?? `event ${activity.eventId}`;
}

function activityTimestamp(activity: ActivityItem): number {
  if (!activity.at) return 0;
  const timestamp = Date.parse(activity.at);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function activitySearchValue(activity: ActivityItem): string {
  return [
    activity.level,
    activity.stage,
    activity.eventType,
    activity.message,
    activity.title,
    activity.company,
    activity.jobKey,
    activity.eventId,
    activity.at,
  ]
    .filter(Boolean)
    .join(" ");
}

const activityColumns: Array<DataGridColumn<ActivityItem>> = [
  {
    id: "level",
    label: "Level",
    getFilterValue: (activity) => activity.level,
    getSortValue: (activity) => activity.level,
    render: (activity) => (
      <span className={`tag ${activity.level === "error" ? "danger" : "muted"}`}>
        {activity.level}
      </span>
    ),
  },
  {
    id: "stage",
    label: "Stage",
    getFilterValue: (activity) => activity.stage,
    getSortValue: (activity) => activity.stage,
    render: (activity) => <span className="stage-pill">{activity.stage}</span>,
  },
  {
    id: "activity",
    label: "Activity",
    rowHeader: true,
    getFilterValue: (activity) => activity.message,
    getFilterSearchValue: activitySearchValue,
    getSortValue: (activity) => activity.message,
    render: (activity) => (
      <span className="activity-main">
        <b>{activity.message}</b>
        <span>{activityContext(activity)}</span>
      </span>
    ),
  },
  {
    id: "event",
    label: "Event",
    getFilterValue: (activity) => activity.eventType,
    getSortValue: (activity) => activity.eventType,
    render: (activity) => <span className="mono">{activity.eventType}</span>,
  },
  {
    id: "at",
    label: "When",
    className: "mono activity-time-cell",
    getSortValue: activityTimestamp,
    render: (activity) => (
      <span title={`${formatDateTime(activity.at)} #${activity.eventId}`}>
        {formatDateTime(activity.at)} #{activity.eventId}
      </span>
    ),
  },
];

export function ActivityFeed({ summary }: ActivityFeedProps) {
  const navigate = useNavigate();
  return (
    <section className="card">
      <FilterableDataGrid<ActivityItem>
        title="Recent activity"
        data={summary.activity}
        columns={activityColumns}
        getRowId={(activity) => activity.eventId}
        loading={false}
        loadingMessage="Loading activity."
        emptyMessage="No activity yet."
        initialSort={{ columnId: "at", direction: "desc" }}
        paginate
        initialPageSize={50}
        tableClassName="activity-data-grid-table"
        onRowActivate={(activity) =>
          void navigate({
            to: "/activity/$eventId",
            params: { eventId: activity.eventId },
          })
        }
      />
    </section>
  );
}
