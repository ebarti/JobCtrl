import { useNavigate } from "@tanstack/react-router";

import type { DashboardSummary } from "../../contexts/operations/types.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import { CardHeader } from "../../shared/ui/card-header.js";
import { Empty } from "../../shared/ui/empty.js";

export interface ActivityFeedProps {
  summary: DashboardSummary;
}

export function ActivityFeed({ summary }: ActivityFeedProps) {
  const navigate = useNavigate();
  return (
    <section className="card">
      <CardHeader title="Recent activity" meta={`${summary.activity.length} events`} />
      <div className="rows">
        {summary.activity.length ? (
          summary.activity.map((activity, index) => (
            <button
              key={`${activity.eventId}-${activity.at}-${index}`}
              type="button"
              className="activity-row clickable-row"
              onClick={() =>
                void navigate({
                  to: "/activity/$eventId",
                  params: { eventId: activity.eventId },
                })
              }
            >
              <span className={`tag ${activity.level === "error" ? "danger" : "muted"}`}>
                {activity.level}
              </span>
              <span className="stage-pill">{activity.stage}</span>
              <span className="activity-main">
                <b>{activity.message}</b>
                <span>
                  {activity.title
                    ? `${activity.title} · ${activity.company ?? "Unknown"}`
                    : (activity.jobKey ?? `event ${activity.eventId}`)}
                </span>
              </span>
              <span className="mono" title={`${formatDateTime(activity.at)} #${activity.eventId}`}>
                {formatDateTime(activity.at)} #{activity.eventId}
              </span>
            </button>
          ))
        ) : (
          <Empty title="No activity yet." />
        )}
      </div>
    </section>
  );
}
