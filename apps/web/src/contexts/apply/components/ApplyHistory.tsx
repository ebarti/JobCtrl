import { Link } from "@tanstack/react-router";
import type { JSX } from "react";

import {
  type ApplyRunSummary,
  useApplyRunsListQuery,
} from "../../operations/hooks/useApplyRunsListQuery.js";
import { Empty } from "../../../shared/ui/empty.js";
import { RelativeTime } from "../../../shared/ui/relative-time.js";
import { ApplyRunBadge } from "./ApplyRunBadge.js";
import { isApplyRunStatus } from "../lib/apply-run-status.js";

export interface ApplyHistoryProps {
  jobId: string;
}

function jobRuns(runs: readonly ApplyRunSummary[], jobId: string): readonly ApplyRunSummary[] {
  return runs.filter((run) => run.jobKey === jobId);
}

export function ApplyHistory({ jobId }: ApplyHistoryProps): JSX.Element {
  const { data: runs, isLoading } = useApplyRunsListQuery();
  if (isLoading && !runs) {
    return <Empty title="Loading apply history." />;
  }
  const filtered = runs ? jobRuns(runs, jobId) : [];
  if (filtered.length === 0) {
    return <Empty title="No apply runs for this job." />;
  }
  return (
    <ol className="apply-history">
      {filtered.map((run) => (
        <li key={run.runId} className="apply-history-row">
          <Link
            to="/jobs/$jobId/run/$runId"
            params={{ jobId, runId: run.runId }}
            className="title-link"
          >
            <span className="mono">{run.runId}</span>
          </Link>
          {isApplyRunStatus(run.status) ? (
            <ApplyRunBadge result={run.status} />
          ) : null}
          {run.dryRun ? <span className="tag muted">dry-run</span> : null}
          <RelativeTime value={run.startedAt} />
        </li>
      ))}
    </ol>
  );
}
