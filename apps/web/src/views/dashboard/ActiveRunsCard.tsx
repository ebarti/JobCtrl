import { IconAlertTriangle, IconBan, IconClock, type TablerIcon } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";

import type { WorkflowRunSummary } from "../../contexts/operations/types.js";
import { Alert, AlertDescription, AlertTitle } from "../../shared/ui/alert.js";
import { CardHeader } from "../../shared/ui/card-header.js";
import { Empty } from "../../shared/ui/empty.js";
import { RelativeTime } from "../../shared/ui/relative-time.js";
import { StatusBadge } from "../../shared/ui/status-badge.js";
import type { StatusTagTone } from "../../shared/ui/status-tokens.js";

const ACTIVE_RUN_LIMIT = 8;

const ACTIVE_RUN_TONE = {
  canceled: "muted",
  captcha: "warn",
  dry_run_complete: "muted",
  expired: "danger",
  failed: "danger",
  in_progress: "info",
  login_issue: "warn",
  manual: "warn",
  starting: "info",
  succeeded: "ok",
  terminated: "danger",
  timed_out: "danger",
} satisfies Record<WorkflowRunSummary["status"], StatusTagTone>;

function activeRunStatusLabel(status: WorkflowRunSummary["status"]): string {
  if (status === "dry_run_complete") {
    return "dry-run complete";
  }
  return status.replaceAll("_", " ");
}

function activeRunStatusIcon(
  status: WorkflowRunSummary["status"],
): TablerIcon | undefined {
  if (status === "starting" || status === "in_progress") return IconClock;
  if (status === "canceled" || status === "terminated") return IconBan;
  return undefined;
}

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
      {error ? (
        <Alert variant="destructive" className="dashboard-inline-alert">
          <IconAlertTriangle aria-hidden="true" />
          <AlertTitle>Active runs unavailable</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
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
              <StatusBadge
                icon={activeRunStatusIcon(run.status)}
                tone={ACTIVE_RUN_TONE[run.status]}
              >
                {activeRunStatusLabel(run.status)}
              </StatusBadge>
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
