import { IconBan } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";

import type { DashboardSummary } from "../../contexts/operations/types.js";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../shared/ui/card.js";
import { Button } from "../../shared/ui/button.js";
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
          <h2 data-typography="component-title">Work status</h2>
        </CardTitle>
        <CardAction>
          <span className="meta" data-typography="metadata">
            {work.active} active · {work.stuck} stuck
          </span>
        </CardAction>
      </CardHeader>
      <CardContent className="work-status-content">
        <div
          className="work-status-metrics"
          role="group"
          aria-label="Work status summary"
        >
          <dl className="work-status-metric">
            <dt data-typography="label">Active work</dt>
            <dd className="work-status-metric-value" data-typography="metric">
              {work.active}
            </dd>
            <dd className="work-status-metric-description" data-typography="body">
              queued or moving
            </dd>
          </dl>
          <Separator
            orientation="vertical"
            className="work-status-metric-separator"
          />
          <dl
            className="work-status-metric"
            data-attention={work.stuck ? "true" : "false"}
          >
            <dt data-typography="label">Stuck work</dt>
            <dd className="work-status-metric-value" data-typography="metric">
              {work.stuck}
            </dd>
            <dd className="work-status-metric-description" data-typography="body">
              {work.stuck
                ? `worker unavailable · stale over ${formatThreshold(work.stuckAfterSeconds)}`
                : `no stuck work over ${formatThreshold(work.stuckAfterSeconds)}`}
            </dd>
          </dl>
        </div>
        <Separator />
        <div className="rows">
          {work.stuckItems.length ? (
            work.stuckItems.map((item) => (
              <Button
                key={`${item.jobKey}:${item.stage}`}
                type="button"
                variant="ghost"
                className="mini-row clickable-row"
                onClick={() =>
                  void navigate({
                    to: "/jobs/$jobId",
                    params: { jobId: item.jobKey },
                    search: kpiSearchFor("all"),
                  })
                }
              >
                <StatusBadge icon={IconBan} tone="danger">
                  stuck
                </StatusBadge>
                <span className="title-stack">
                  <b data-typography="strong-body">{item.title}</b>
                  <span data-typography="metadata">
                    {item.company} · {item.stage}
                  </span>
                </span>
                <RelativeTime
                  value={item.updatedAt}
                  fallback="timestamp missing"
                />
              </Button>
            ))
          ) : (
            <Empty title="No stuck work." />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
