import { useNavigate } from "@tanstack/react-router";

import type { DashboardSummary } from "../../contexts/operations/types.js";
import { CardHeader } from "../../shared/ui/card-header.js";
import { Empty } from "../../shared/ui/empty.js";
import { RelativeTime } from "../../shared/ui/relative-time.js";
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
    <section className="card">
      <CardHeader
        title="Work status"
        meta={`${work.active} active · ${work.stuck} stuck`}
      />
      <dl className="work-status-ledger" aria-label="Work status summary">
        <div className="work-status-ledger__cell">
          <dt data-slot="stat-label">Active work</dt>
          <dd>
            <span data-slot="stat-value">{work.active}</span>
            <span data-slot="stat-delta">queued or moving</span>
          </dd>
        </div>
        <div className="work-status-ledger__cell">
          <dt data-slot="stat-label">Stuck work</dt>
          <dd>
            <span data-slot="stat-value">{work.stuck}</span>
            <span data-slot="stat-delta">
              {work.stuck
                ? `worker unavailable · stale over ${formatThreshold(work.stuckAfterSeconds)}`
                : `no stuck work over ${formatThreshold(work.stuckAfterSeconds)}`}
            </span>
          </dd>
        </div>
      </dl>
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
              <span className="dashboard-signal dashboard-signal--danger">stuck</span>
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
    </section>
  );
}
