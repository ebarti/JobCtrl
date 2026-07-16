import { IconArrowLeft } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";

import { RunStatusBadge } from "../../contexts/apply/components/RunStatusBadge.js";
import { useWorkflowRunDetailQuery } from "../../contexts/operations/hooks/useWorkflowRunDetailQuery.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import { buttonVariants } from "../../shared/ui/button.js";
import { Empty } from "../../shared/ui/empty.js";
import { RouteWorkspace } from "../../shared/ui/route-workspace.js";
import { Section } from "../../shared/ui/section.js";

export interface WorkflowRunDrawerProps {
  runId: string;
}

/** Route workspace for the unified Workflow Runs view. */
export function WorkflowRunDrawer({ runId }: WorkflowRunDrawerProps) {
  const { data: run, isLoading, error } = useWorkflowRunDetailQuery(runId);
  const message = error instanceof Error ? error.message : null;
  const notFound = !isLoading && !message && !run;

  return (
    <div
      className="route-page route-page--workflow-run-detail"
      aria-label="Workflow run details"
    >
      {message ? <Empty title={message} /> : null}
      {!message && isLoading ? <Empty title="Loading workflow run." /> : null}
      {notFound ? <Empty title="Workflow run not found." /> : null}
      {run ? (
        <RouteWorkspace
          aria-label="Workflow run details"
          className="workflow-run-workspace"
          contentLabel="Workflow run timeline"
          inspectorLabel="Workflow run facts and failure details"
          header={
            <div className="workflow-run-workspace__header">
              <Link
                aria-label="Back to workflow runs"
                className={buttonVariants({
                  className: "workspace-back",
                  size: "sm",
                  variant: "ghost",
                })}
                search={(prev) => prev}
                to="/runs"
              >
                <IconArrowLeft aria-hidden="true" size={16} stroke={1.9} />
                Runs
              </Link>
              <RunStatusBadge status={run.status} />
              <div className="workflow-run-workspace__title">
                <small>{run.workflowType || "workflow"}</small>
                <h1>{run.title || run.workflowType || "Workflow run"}</h1>
                <p>
                  {run.status}
                  {run.dryRun ? " · dry-run" : ""}
                </p>
              </div>
            </div>
          }
          inspector={
            <div className="workflow-run-workspace__inspector">
              <Section title="Run details">
                <dl className="detail-list">
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
                  {run.jobKey ? (
                    <div>
                      <dt>Job</dt>
                      <dd>{run.title || run.jobKey}</dd>
                    </div>
                  ) : null}
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
                </dl>
              </Section>
              {run.errorMessage || run.errorCode ? (
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
          <div className="workflow-run-workspace__timeline">
            <Section title="Timeline">
              {run.events.length === 0 ? (
                <Empty title="No lifecycle events recorded yet." />
              ) : (
                <ol className="timeline">
                  {run.events.map((event, index) => (
                    <li key={`${event.eventType}-${index}`}>
                      <span className="mono">{event.eventType}</span>
                      <span className="muted">
                        {" "}
                        {formatDateTime(event.occurredAt)}
                      </span>
                      {event.message ? <p>{event.message}</p> : null}
                    </li>
                  ))}
                </ol>
              )}
            </Section>
          </div>
        </RouteWorkspace>
      ) : null}
    </div>
  );
}
