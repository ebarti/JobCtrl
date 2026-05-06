import { useNavigate } from "@tanstack/react-router";

import type { DashboardSummary } from "../../contexts/operations/types.js";
import { CardHeader } from "../../shared/ui/card-header.js";
import { SegmentBar } from "../../shared/ui/segment-bar.js";
import { kpiSearchFor } from "./KpiGrid.js";

export interface FunnelProps {
  summary: DashboardSummary;
}

export function Funnel({ summary }: FunnelProps) {
  const navigate = useNavigate();
  return (
    <section className="card span-2">
      <CardHeader title="Pipeline" meta={`${summary.totals.jobs} jobs`} />
      <div className="funnel">
        {summary.funnel.map((stage, index) => (
          <button
            key={stage.stage}
            type="button"
            className="funnel-row"
            onClick={() => void navigate({ to: "/jobs", search: kpiSearchFor("all") })}
          >
            <span className="funnel-stage">
              <span className="funnel-num">{String(index + 1).padStart(2, "0")}</span> {stage.stage}
            </span>
            <SegmentBar
              total={stage.total}
              values={[
                ["done", stage.succeeded],
                ["failed", stage.failed],
                ["blocked", stage.blocked],
                ["running", stage.running],
                ["pending", stage.pending],
              ]}
            />
            <span className="legend">
              {stage.failed ? <span className="danger">{stage.failed} failed</span> : null}
              {stage.blocked ? <span className="warn">{stage.blocked} blocked</span> : null}
              {stage.running ? <span>{stage.running} running</span> : null}
              <span>{stage.pending} pending</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
