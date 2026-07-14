import { IconArrowLeft } from "@tabler/icons-react";
import { createFileRoute, Link } from "@tanstack/react-router";

import { ApplyRunTimeline } from "../contexts/apply/components/ApplyRunTimeline.js";
import { RunStatusBadge } from "../contexts/apply/components/RunStatusBadge.js";
import { useWorkflowRunDetailQuery } from "../contexts/operations/hooks/useWorkflowRunDetailQuery.js";
import { formatDateTime } from "../shared/lib/formatters.js";
import { Button } from "../shared/ui/button.js";
import { RouteWorkspace } from "../shared/ui/route-workspace.js";
import { Section } from "../shared/ui/section.js";
import { SectionTabs, SectionTabsList } from "../shared/ui/section-tabs.js";
import { StatusLabel } from "../shared/ui/status-label.js";
import { TabsContent, TabsTrigger } from "../shared/ui/tabs.js";

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
      <SectionTabs className="job-run-tabs" defaultValue="summary">
        <RouteWorkspace
          aria-label="Apply run details"
          className="job-run-workspace"
          contentLabel="Apply run workspace panels"
          inspectorLabel="Apply run identity"
          tabs={
            <nav aria-label="Apply run detail panels">
              <SectionTabsList>
                <TabsTrigger value="summary">Summary</TabsTrigger>
                <TabsTrigger value="timeline">Timeline</TabsTrigger>
                <TabsTrigger value="diagnostics">Diagnostics</TabsTrigger>
              </SectionTabsList>
            </nav>
          }
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
              <div className="job-run-workspace__title">
                <small>{run?.workflowType || "apply workflow"}</small>
                <h1>Apply run timeline</h1>
                <p>
                  {run?.title ? `${run.title} · ` : ""}
                  <span className="mono">{runId}</span>
                </p>
              </div>
              <div className="job-run-workspace__status">
                {run ? (
                  <RunStatusBadge status={run.status} />
                ) : (
                  <StatusLabel tone="neutral">
                    {isLoading ? "loading" : "status unavailable"}
                  </StatusLabel>
                )}
              </div>
            </div>
          }
          inspector={
            <div className="job-run-workspace__inspector">
              <Section title="Run identity">
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
                        <dt>Status</dt>
                        <dd>{run.status}</dd>
                      </div>
                    </>
                  ) : null}
                </dl>
              </Section>
              {message ? <div className="banner inline">{message}</div> : null}
            </div>
          }
        >
          <TabsContent
            className="job-run-workspace__panel"
            forceMount
            value="summary"
          >
            <Section
              title="Run details"
              description="Workflow identity and execution boundary"
            >
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
            </Section>
          </TabsContent>
          <TabsContent
            className="job-run-workspace__panel"
            forceMount
            value="timeline"
          >
            <Section
              className="job-run-workspace__timeline"
              title="Timeline"
              description="Immutable workflow and domain events"
            >
              <ApplyRunTimeline runId={runId} events={run?.events ?? []} />
            </Section>
          </TabsContent>
          <TabsContent
            className="job-run-workspace__panel"
            forceMount
            value="diagnostics"
          >
            {run && (run.errorMessage || run.errorCode) ? (
              <Section className="job-run-workspace__failure" title="Failure">
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
              <Section title="Diagnostics">
                <p className="muted">No failure diagnostics recorded.</p>
              </Section>
            )}
          </TabsContent>
        </RouteWorkspace>
      </SectionTabs>
    </div>
  );
}
