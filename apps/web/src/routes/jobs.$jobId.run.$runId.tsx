import { IconArrowLeft } from "@tabler/icons-react";
import { createFileRoute, Link } from "@tanstack/react-router";

import { ApplyRunTimeline } from "../contexts/apply/components/ApplyRunTimeline.js";
import { RunStatusBadge } from "../contexts/apply/components/RunStatusBadge.js";
import { useWorkflowRunDetailQuery } from "../contexts/operations/hooks/useWorkflowRunDetailQuery.js";
import { formatDateTime } from "../shared/lib/formatters.js";
import { Button } from "../shared/ui/button.js";
import { RouteWorkspace } from "../shared/ui/route-workspace.js";
import { Section } from "../shared/ui/section.js";

export const Route = createFileRoute("/jobs/$jobId/run/$runId")({
  component: JobRunTimelineRoute,
});

function JobRunTimelineRoute() {
  const { jobId, runId } = Route.useParams();
  return <JobRunTimelineWorkspace jobId={jobId} runId={runId} />;
}

export interface JobRunTimelineWorkspaceProps {
  readonly jobId: string;
  readonly runId: string;
}

export function JobRunTimelineWorkspace({
  jobId,
  runId,
}: JobRunTimelineWorkspaceProps) {
  const { data: run, isLoading, error } = useWorkflowRunDetailQuery(runId);
  const message = error instanceof Error ? error.message : null;

  return (
    <div
      className="route-page route-page--job-run-detail"
      aria-label="Apply run details"
    >
      <RouteWorkspace
        aria-label="Apply run details"
        className="job-run-workspace"
        contentLabel="Apply run timeline"
        inspectorLabel="Apply run facts and failure details"
        header={
          <div className="job-run-workspace__header">
            <Button asChild className="workspace-back" size="sm" variant="ghost">
              <Link
                aria-label="Back to job details"
                params={{ jobId }}
                search={(prev) => prev}
                to="/jobs/$jobId"
              >
                <IconArrowLeft aria-hidden="true" size={16} stroke={1.9} />
                Job details
              </Link>
            </Button>
            {run ? (
              <RunStatusBadge status={run.status} />
            ) : (
              <span className="tag muted">
                {isLoading ? "loading" : "status unavailable"}
              </span>
            )}
            <div className="job-run-workspace__title">
              <small>{run?.workflowType || "apply workflow"}</small>
              <h1>Apply run timeline</h1>
              <p>
                {run?.title ? `${run.title} · ` : ""}
                <span className="mono">{runId}</span>
              </p>
            </div>
          </div>
        }
        inspector={
          <div className="job-run-workspace__inspector">
            <Section title="Run details">
              <dl className="detail-list">
                <div>
                  <dt>Run id</dt>
                  <dd className="mono">{runId}</dd>
                </div>
                <div>
                  <dt>Job</dt>
                  <dd>
                    <Link
                      className="title-link"
                      params={{ jobId }}
                      search={(prev) => prev}
                      to="/jobs/$jobId"
                    >
                      {run?.title || jobId}
                    </Link>
                  </dd>
                </div>
                {run ? (
                  <>
                    <div>
                      <dt>Workflow id</dt>
                      <dd className="mono">{run.workflowId}</dd>
                    </div>
                    <div>
                      <dt>Type</dt>
                      <dd>{run.workflowType || "-"}</dd>
                    </div>
                    <div>
                      <dt>Status</dt>
                      <dd>{run.status}</dd>
                    </div>
                    <div>
                      <dt>Started</dt>
                      <dd>{formatDateTime(run.startedAt)}</dd>
                    </div>
                    <div>
                      <dt>Finished</dt>
                      <dd>
                        {run.finishedAt ? formatDateTime(run.finishedAt) : "-"}
                      </dd>
                    </div>
                    {run.temporalRunId ? (
                      <div>
                        <dt>Temporal run id</dt>
                        <dd className="mono">{run.temporalRunId}</dd>
                      </div>
                    ) : null}
                    <div>
                      <dt>Mode</dt>
                      <dd>{run.dryRun ? "dry-run" : "live"}</dd>
                    </div>
                  </>
                ) : null}
              </dl>
              {message ? <div className="banner inline">{message}</div> : null}
            </Section>
            {run && (run.errorMessage || run.errorCode) ? (
              <Section title="Failure">
                <dl className="detail-list">
                  {run.errorCode ? (
                    <div>
                      <dt>Error code</dt>
                      <dd className="mono">{run.errorCode}</dd>
                    </div>
                  ) : null}
                  {run.errorMessage ? (
                    <div>
                      <dt>Message</dt>
                      <dd>{run.errorMessage}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>Retryable</dt>
                    <dd>{run.retryable ? "yes" : "no"}</dd>
                  </div>
                </dl>
              </Section>
            ) : null}
          </div>
        }
      >
        <Section className="job-run-workspace__timeline" title="Timeline">
          <ApplyRunTimeline runId={runId} events={run?.events ?? []} />
        </Section>
      </RouteWorkspace>
    </div>
  );
}
