import { useNavigate } from "@tanstack/react-router";

import type { DashboardSummary } from "../../contexts/operations/types.js";
import { CardHeader } from "../../shared/ui/card-header.js";
import { Button } from "../../shared/ui/button.js";
import { Empty } from "../../shared/ui/empty.js";
import { RelativeTime } from "../../shared/ui/relative-time.js";
import { StatusBadge } from "../../shared/ui/status-badge.js";
import type { StatusTagTone } from "../../shared/ui/status-tokens.js";

const RECENT_ACTIVITY_LIMIT = 8;

type Activity = DashboardSummary["activity"][number];

function activityTone(activity: Activity): StatusTagTone {
  const level = activity.level.trim().toLowerCase();
  if (level === "error") return "danger";
  if (level === "warn" || level === "warning") return "warn";
  return level === "info" ? "info" : "muted";
}

function activityContext(activity: Activity): string {
  if (activity.title) {
    return `${activity.title} · ${activity.company ?? "Unknown company"}`;
  }
  return activity.jobKey ?? `event ${activity.eventId}`;
}

export function RecentActivityCard({ summary }: { summary: DashboardSummary }) {
  const navigate = useNavigate();
  const activity = summary.activity.slice(0, RECENT_ACTIVITY_LIMIT);
  return (
    <section className="card">
      <CardHeader
        title="Recent activity"
        meta={`${activity.length} of ${summary.activity.length} events`}
      />
      <div className="rows">
        {activity.length ? (
          activity.map((entry) => (
            <Button
              key={entry.eventId}
              type="button"
              variant="ghost"
              className="mini-row clickable-row"
              onClick={() =>
                void navigate({
                  to: "/activity/$eventId",
                  params: { eventId: entry.eventId },
                })
              }
            >
              <StatusBadge tone={activityTone(entry)}>{entry.level}</StatusBadge>
              <span className="title-stack">
                <b data-typography="strong-body">{entry.message}</b>
                <span data-typography="metadata">
                  {entry.stage} · {activityContext(entry)}
                </span>
              </span>
              <RelativeTime value={entry.at} />
            </Button>
          ))
        ) : (
          <Empty title="No activity yet." />
        )}
      </div>
    </section>
  );
}
