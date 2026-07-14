import { IconArrowLeft, IconExternalLink } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";

import { RunStatusBadge } from "../../contexts/apply/components/RunStatusBadge.js";
import { useWorkflowRunDetailQuery } from "../../contexts/operations/hooks/useWorkflowRunDetailQuery.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import { Button } from "../../shared/ui/button.js";
import { Empty } from "../../shared/ui/empty.js";
import { RouteWorkspace } from "../../shared/ui/route-workspace.js";
import { Section } from "../../shared/ui/section.js";
import { SectionTabs, SectionTabsList } from "../../shared/ui/section-tabs.js";
import { TabsContent, TabsTrigger } from "../../shared/ui/tabs.js";
import { temporalWebUiWorkflowUrl } from "./temporal-web-ui.js";

export interface WorkflowRunDrawerProps {
  runId: string;
}

/**
 * Route workspace for the unified Workflow Runs view — renders any workflow
 * type from `GET /v1/workflow-runs/:runId`, including non-apply runs. The
 * folded lifecycle timeline gives a durable, at-a-glance record of the
 * start marker and terminal event (Temporal loop closure, P0).
 */
export function WorkflowRunDrawer({ runId }: WorkflowRunDrawerProps) {
  const { data: run, isLoading, error } = useWorkflowRunDetailQuery(runId);
  const message = error instanceof Error ? error.message : null;
  const stateTitle = message
    ? message
    : isLoading
      ? "Loading workflow run."
      : "Workflow run not found.";

  return (
    <div
      className="route-page route-page--workflow-run-detail"
      aria-label="Workflow run details"
    >
      {!run ? (
        <section className="detail-route-state" aria-label="Workflow run state">
          <Button asChild className="workspace-back" size="sm" variant="ghost">
            <Link
              aria-label="Back to workflow runs"
              search={(prev) => prev}
              to="/runs"
            >
              <IconArrowLeft aria-hidden="true" size={16} stroke={1.9} />
              Runs
            </Link>
          </Button>
          <Empty title={stateTitle} />
        </section>
      ) : null}
      {run ? (
        <SectionTabs className="workflow-run-tabs" defaultValue="summary">
          <RouteWorkspace
            aria-label="Workflow run details"
            className="workflow-run-workspace"
            contentLabel="Workflow run workspace panels"
            inspectorLabel="Workflow run identity"
            tabs={
              <nav aria-label="Workflow run detail panels">
                <SectionTabsList>
                  <TabsTrigger value="summary">Summary</TabsTrigger>
                  <TabsTrigger value="timeline">Timeline</TabsTrigger>
                  <TabsTrigger value="diagnostics">Diagnostics</TabsTrigger>
                </SectionTabsList>
              </nav>
            }
            header={
              <div className="workflow-run-workspace__header">
                <Button
                  asChild
                  className="workspace-back"
                  size="sm"
                  variant="ghost"
                >
                  <Link
                    aria-label="Back to workflow runs"
                    search={(prev) => prev}
                    to="/runs"
                  >
                    <IconArrowLeft aria-hidden="true" size={16} stroke={1.9} />
                    Runs
                  </Link>
                </Button>
                <span className="workflow-run-workspace__status">
                  <RunStatusBadge status={run.status} />
                </span>
                <div className="workflow-run-workspace__title">
                  <small>{run.workflowType || "workflow"}</small>
                  <h1>{run.title || run.workflowType || "Workflow run"}</h1>
                  <p>
                    {run.status}
                    {run.dryRun ? " · dry-run" : ""}
                  </p>
                </div>
                <div className="workflow-run-workspace__actions">
                  <Button asChild size="sm" variant="outline">
                    <a
                      href={temporalWebUiWorkflowUrl(run.workflowId)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <IconExternalLink
                        aria-hidden="true"
                        size={15}
                        stroke={1.8}
                      />
                      Open in Temporal
                    </a>
                  </Button>
                </div>
              </div>
            }
            inspector={
              <div className="workflow-run-workspace__inspector">
                <Section title="Run identity">
                  <dl className="detail-list">
                    <div>
                      <dt>Workflow id</dt>
                      <dd className="mono">{run.workflowId}</dd>
                    </div>
                    <div>
                      <dt>Status</dt>
                      <dd>{run.status}</dd>
                    </div>
                    {run.temporalRunId ? (
                      <div>
                        <dt>Temporal run id</dt>
                        <dd className="mono">{run.temporalRunId}</dd>
                      </div>
                    ) : null}
                  </dl>
                </Section>
              </div>
            }
          >
            <TabsContent
              className="workflow-run-workspace__panel"
              forceMount
              value="summary"
            >
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
            </TabsContent>
            <TabsContent
              className="workflow-run-workspace__panel"
              forceMount
              value="timeline"
            >
              <Section
                className="workflow-run-workspace__timeline"
                title="Timeline"
              >
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
            </TabsContent>
            <TabsContent
              className="workflow-run-workspace__panel"
              forceMount
              value="diagnostics"
            >
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
              ) : (
                <Empty title="No failure diagnostics recorded." />
              )}
            </TabsContent>
          </RouteWorkspace>
        </SectionTabs>
      ) : null}
    </div>
  );
}
