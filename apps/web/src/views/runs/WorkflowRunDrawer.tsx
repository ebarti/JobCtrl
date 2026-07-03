import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { RunStatusBadge } from "../../contexts/apply/components/RunStatusBadge.js";
import { useWorkflowRunDetailQuery } from "../../contexts/operations/hooks/useWorkflowRunDetailQuery.js";
import { useEscapeKey } from "../../shared/hooks/useEscapeKey.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import { DetailDrawerBackdrop } from "../../shared/ui/detail-drawer-backdrop.js";
import { Empty } from "../../shared/ui/empty.js";
import { Section } from "../../shared/ui/section.js";

export interface WorkflowRunDrawerProps {
  runId: string;
}

/**
 * Detail drawer for the unified Workflow Runs view — renders any workflow
 * type from `GET /v1/workflow-runs/:runId`, including non-apply runs. The
 * folded lifecycle timeline gives a durable, at-a-glance record of the
 * start marker and terminal event (Temporal loop closure, P0).
 */
export function WorkflowRunDrawer({ runId }: WorkflowRunDrawerProps) {
  const navigate = useNavigate();
  const close = useCallback(() => {
    void navigate({ to: "/runs" });
  }, [navigate]);
  useEscapeKey(true, close);

  const { data: run, isLoading, error } = useWorkflowRunDetailQuery(runId);
  const message = error instanceof Error ? error.message : null;
  const notFound = !isLoading && !message && !run;

  return (
    <DetailDrawerBackdrop onDismiss={close}>
      <div
        className="drawer detail-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Workflow run details"
      >
        <button
          aria-label="Close workflow run details"
          className="drawer-close"
          type="button"
          onClick={close}
        >
          x
        </button>
        {message ? <Empty title={message} /> : null}
        {!message && isLoading ? <Empty title="Loading workflow run." /> : null}
        {notFound ? <Empty title="Workflow run not found." /> : null}
        {run ? (
          <>
            <div className="drawer-head">
              <RunStatusBadge status={run.status} />
              <span>
                <small>{run.workflowType || "workflow"}</small>
                <h2>{run.title || run.workflowType || "Workflow run"}</h2>
                <p>
                  {run.status}
                  {run.dryRun ? " · dry-run" : ""}
                </p>
              </span>
            </div>
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
                  <dd>{run.finishedAt ? formatDateTime(run.finishedAt) : "-"}</dd>
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
            <Section title="Timeline">
              {run.events.length === 0 ? (
                <Empty title="No lifecycle events recorded yet." />
              ) : (
                <ol className="timeline">
                  {run.events.map((event, index) => (
                    <li key={`${event.eventType}-${index}`}>
                      <span className="mono">{event.eventType}</span>
                      <span className="muted"> {formatDateTime(event.occurredAt)}</span>
                      {event.message ? <p>{event.message}</p> : null}
                    </li>
                  ))}
                </ol>
              )}
            </Section>
          </>
        ) : null}
      </div>
    </DetailDrawerBackdrop>
  );
}
