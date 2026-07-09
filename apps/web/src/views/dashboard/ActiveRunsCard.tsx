import { useNavigate } from "@tanstack/react-router";

import { RunStatusBadge } from "../../contexts/apply/components/RunStatusBadge.js";
import type { WorkflowRunSummary } from "../../contexts/operations/types.js";
import { CardHeader } from "../../shared/ui/card-header.js";
import { Empty } from "../../shared/ui/empty.js";
import { RelativeTime } from "../../shared/ui/relative-time.js";

const ACTIVE_RUN_LIMIT = 8;

export interface ActiveRunsCardProps {
  runs: readonly WorkflowRunSummary[];
  loading: boolean;
  error: string | null;
}

export function ActiveRunsCard({ runs, loading, error }: ActiveRunsCardProps) {
  const navigate = useNavigate();
  const visibleRuns = runs.slice(0, ACTIVE_RUN_LIMIT);
  return (
    <section className="card">
      <CardHeader title="Active runs" meta={`${visibleRuns.length} shown`} />
      {error ? <div className="banner inline">{error}</div> : null}
      <div className="rows">
        {visibleRuns.length ? (
          visibleRuns.map((run) => (
            <button
              key={run.workflowId}
              type="button"
              className="mini-row clickable-row"
              onClick={() =>
                void navigate({
                  to: "/runs/$runId",
                  params: { runId: run.workflowId },
                })
              }
            >
              <RunStatusBadge status={run.status} />
              <span className="title-stack">
                <b>{run.title || run.workflowType || "Workflow"}</b>
                <span>{run.company || run.workflowType || run.workflowId}</span>
              </span>
              <RelativeTime value={run.startedAt} />
            </button>
          ))
        ) : (
          <Empty
            title={
              loading
                ? "Loading active workflow runs."
                : "No active workflow runs."
            }
          />
        )}
      </div>
    </section>
  );
}
