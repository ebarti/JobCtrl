import { useNavigate } from "@tanstack/react-router";

import type { DashboardSummary } from "../../contexts/operations/types.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import { CardHeader } from "../../shared/ui/card-header.js";
import { Button } from "../../shared/ui/button.js";
import { Empty } from "../../shared/ui/empty.js";
import { StatusBadge } from "../../shared/ui/status-badge.js";
import { StatusDot } from "../../shared/ui/status-dot.js";
import { applyRunDotState } from "./apply-run-dot-state.js";

type ApplyRunSummary = DashboardSummary["applyRuns"][number];

export interface ApplyRunsCardProps {
  summary: DashboardSummary;
}

export function ApplyRunsCard({ summary }: ApplyRunsCardProps) {
  const navigate = useNavigate();
  return (
    <section className="card">
      <CardHeader title="Apply runs" meta={`${summary.applyRuns.length} recent`} />
      <div className="rows">
        {summary.applyRuns.length ? (
          summary.applyRuns.map((run: ApplyRunSummary) => (
            <Button
              key={run.runId}
              type="button"
              variant="ghost"
              className="mini-row clickable-row"
              onClick={() => void navigate({ to: "/runs/$runId", params: { runId: run.runId } })}
            >
              <StatusDot state={applyRunDotState(run.status)} />
              <span className="title-stack">
                <b data-typography="strong-body">{run.title}</b>
                <span data-typography="metadata">
                  {run.company} · {formatDateTime(run.startedAt)}
                </span>
              </span>
              {run.dryRun ? (
                <StatusBadge icon={false} tone="info">
                  dry-run
                </StatusBadge>
              ) : null}
            </Button>
          ))
        ) : (
          <Empty title="No apply runs." />
        )}
      </div>
    </section>
  );
}
