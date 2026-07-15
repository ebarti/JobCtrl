import { useNavigate } from "@tanstack/react-router";

import type { DashboardSummary } from "../../contexts/operations/types.js";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../shared/ui/card.js";
import { Empty } from "../../shared/ui/empty.js";
import { RelativeTime } from "../../shared/ui/relative-time.js";
import { Separator } from "../../shared/ui/separator.js";
import { StatusBadge } from "../../shared/ui/status-badge.js";
import { kpiSearchFor } from "./KpiGrid.js";

function formatThreshold(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (!minutes) return `${seconds}s`;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

export function WorkStatusCard({ summary }: { summary: DashboardSummary }) {
  const navigate = useNavigate();
  const { work } = summary;
  return (
    <Card className="card work-status-card">
      <CardHeader className="card-hd">
        <CardTitle>
          <h2>Work status</h2>
        </CardTitle>
        <CardAction>
          <span className="meta">
            {work.active} active · {work.stuck} stuck
          </span>
        </CardAction>
      </CardHeader>
      <CardContent className="work-status-content">
        <dl className="work-status-metrics" aria-label="Work status summary">
          <div className="work-status-metric">
            <dt>Active work</dt>
            <dd>{work.active}</dd>
            <span>queued or moving</span>
          </div>
          <Separator orientation="vertical" className="work-status-metric-separator" />
          <div className="work-status-metric" data-attention={work.stuck ? "true" : "false"}>
            <dt>Stuck work</dt>
            <dd>{work.stuck}</dd>
            <span>
              {work.stuck
                ? `worker unavailable · stale over ${formatThreshold(work.stuckAfterSeconds)}`
                : `no stuck work over ${formatThreshold(work.stuckAfterSeconds)}`}
            </span>
          </div>
        </dl>
        <Separator />
        <div className="rows">
          {work.stuckItems.length ? (
            work.stuckItems.map((item) => (
              <button
                key={`${item.jobKey}:${item.stage}`}
                type="button"
                className="mini-row clickable-row"
                onClick={() =>
                  void navigate({
                    to: "/jobs/$jobId",
                    params: { jobId: item.jobKey },
                    search: kpiSearchFor("all"),
                  })
                }
              >
                <StatusBadge tone="danger">stuck</StatusBadge>
                <span className="title-stack">
                  <b>{item.title}</b>
                  <span>
                    {item.company} · {item.stage}
                  </span>
                </span>
                <RelativeTime
                  value={item.updatedAt}
                  fallback="timestamp missing"
                />
              </button>
            ))
          ) : (
            <Empty title="No stuck work." />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
