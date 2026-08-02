import {
  IconArrowLeft,
  IconBug,
  IconCheck,
  IconCopy,
  IconExternalLink,
  IconRefresh,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useCallback, useState, type ReactNode } from "react";

import { RunStatusBadge } from "../../contexts/apply/components/RunStatusBadge.js";
import { useWorkflowRunDetailQuery } from "../../contexts/operations/hooks/useWorkflowRunDetailQuery.js";
import type {
  WorkflowRunDetail,
  WorkflowRunTimelineEvent,
} from "../../contexts/operations/types.js";
import { CancelWorkflowRunButton } from "../../contexts/pipeline/components/CancelWorkflowRunButton.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { Button, buttonVariants } from "../../shared/ui/button.js";
import { Empty } from "../../shared/ui/empty.js";
import { RouteWorkspace } from "../../shared/ui/route-workspace.js";
import { temporalWebUiWorkflowUrl } from "./temporal-web-ui.js";

export interface WorkflowRunDrawerProps {
  runId: string;
}

interface TimelineEntry extends WorkflowRunTimelineEvent {
  readonly ownsFailure: boolean;
  readonly synthetic: boolean;
}

const ACTIVE_RUN_STATUSES = new Set(["starting", "in_progress"]);

function humanizeIdentifier(value: string): string {
  const words = value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : "Event";
}

function workflowTitle(run: WorkflowRunDetail): string {
  const title = run.title || run.workflowType || "Workflow run";
  return title === run.workflowType ? humanizeIdentifier(title) : title;
}

function formatDuration(value: number | null): string {
  if (value === null || value < 0) return "Not available";
  if (value < 1_000) return `${value} ms`;
  const seconds = Math.round(value / 1_000);
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes} min ${remainder} sec` : `${minutes} min`;
}

function hasFailure(run: WorkflowRunDetail): boolean {
  return Boolean(run.errorCode || run.errorMessage);
}

function isFailureEvent(event: WorkflowRunTimelineEvent): boolean {
  return (
    event.status?.toLowerCase() === "failed" || /fail/i.test(event.eventType)
  );
}

function timelineEntries(run: WorkflowRunDetail): readonly TimelineEntry[] {
  const failureIndex = run.events.reduce(
    (match, event, index) => (isFailureEvent(event) ? index : match),
    -1,
  );
  const entries = run.events.map((event, index) => ({
    ...event,
    ownsFailure: hasFailure(run) && index === failureIndex,
    synthetic: false,
  }));
  if (!hasFailure(run) || failureIndex >= 0) return entries;
  return [
    ...entries,
    {
      eventType: "Workflow failure recorded",
      occurredAt: run.finishedAt,
      status: "failed",
      message: null,
      ownsFailure: true,
      synthetic: true,
    },
  ];
}

function CopyValueButton({
  value,
  label,
}: {
  readonly value: string;
  readonly label: string;
}) {
  const { clipboard } = usePorts();
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    void clipboard
      .write(value)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_500);
      })
      .catch(() => setCopied(false));
  }, [clipboard, value]);

  return (
    <Button
      aria-label={`Copy ${label}`}
      className="workflow-run-copy"
      onClick={onCopy}
      size="sm"
      title={`Copy ${label}`}
      type="button"
      variant="ghost"
    >
      {copied ? (
        <IconCheck aria-hidden="true" />
      ) : (
        <IconCopy aria-hidden="true" />
      )}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function RunActions({ run }: { readonly run: WorkflowRunDetail }) {
  const recoveryTarget = run.jobKey ? "job" : "pipeline";
  const needsRecovery = run.status === "failed" || hasFailure(run);
  return (
    <nav aria-label="Run actions" className="workflow-run-actions">
      {needsRecovery && recoveryTarget === "job" ? (
        <Link
          className={buttonVariants({
            className: "workflow-run-actions__primary",
            size: "sm",
          })}
          data-typography="control"
          params={{ jobId: run.jobKey }}
          to="/jobs/$jobId"
        >
          <IconRefresh aria-hidden="true" />
          Review job recovery
        </Link>
      ) : null}
      {needsRecovery && recoveryTarget === "pipeline" ? (
        <Link
          className={buttonVariants({
            className: "workflow-run-actions__primary",
            size: "sm",
          })}
          data-typography="control"
          to="/pipelines"
        >
          <IconRefresh aria-hidden="true" />
          Open pipeline controls
        </Link>
      ) : null}
      {ACTIVE_RUN_STATUSES.has(run.status) ? (
        <CancelWorkflowRunButton
          ariaLabel={`Stop workflow run ${run.workflowId}`}
          className="workflow-run-actions__primary"
          label="Stop run"
          runId={run.runId}
        />
      ) : null}
      <a
        aria-label={`Open workflow ${run.workflowId} in Temporal Web UI`}
        className={buttonVariants({ size: "sm", variant: "outline" })}
        data-typography="control"
        href={temporalWebUiWorkflowUrl(run.workflowId)}
        rel="noopener noreferrer"
        target="_blank"
      >
        <IconExternalLink aria-hidden="true" />
        View in Temporal
      </a>
      <Link
        className={buttonVariants({ size: "sm", variant: "ghost" })}
        data-typography="control"
        search={{
          dir: "desc",
          eventType: "",
          level: "",
          page: 1,
          pageSize: 50,
          q: run.jobKey || run.workflowId,
          sort: "occurred_at",
          stage: "",
        }}
        to="/debug"
      >
        <IconBug aria-hidden="true" />
        Review activity
      </Link>
    </nav>
  );
}

function RunMetadata({ run }: { readonly run: WorkflowRunDetail }) {
  return (
    <RunSection id="workflow-run-details-title" title="Run details">
      <dl className="workflow-run-metadata">
        <div className="workflow-run-metadata__identity">
          <dt data-typography="label">Workflow id</dt>
          <dd>
            <code data-typography="code">{run.workflowId}</code>
            <CopyValueButton label="workflow id" value={run.workflowId} />
          </dd>
        </div>
        {run.runId !== run.workflowId ? (
          <div className="workflow-run-metadata__identity">
            <dt data-typography="label">Run id</dt>
            <dd>
              <code data-typography="code">{run.runId}</code>
              <CopyValueButton label="run id" value={run.runId} />
            </dd>
          </div>
        ) : null}
        {run.temporalRunId ? (
          <div className="workflow-run-metadata__identity">
            <dt data-typography="label">Temporal run id</dt>
            <dd>
              <code data-typography="code">{run.temporalRunId}</code>
              <CopyValueButton
                label="Temporal run id"
                value={run.temporalRunId}
              />
            </dd>
          </div>
        ) : null}
        <div>
          <dt data-typography="label">Workflow type</dt>
          <dd data-typography="code">{run.workflowType || "Not available"}</dd>
        </div>
        {run.jobKey ? (
          <div>
            <dt data-typography="label">Job</dt>
            <dd data-typography="body">
              {run.title || run.jobKey}
              {run.company ? ` · ${run.company}` : ""}
            </dd>
          </div>
        ) : null}
        <div>
          <dt data-typography="label">Mode</dt>
          <dd data-typography="body">{run.dryRun ? "Dry run" : "Live"}</dd>
        </div>
        <div>
          <dt data-typography="label">Started</dt>
          <dd data-typography="body">{formatDateTime(run.startedAt)}</dd>
        </div>
        <div>
          <dt data-typography="label">Finished</dt>
          <dd data-typography="body">
            {run.finishedAt ? formatDateTime(run.finishedAt) : "Not finished"}
          </dd>
        </div>
        <div>
          <dt data-typography="label">Duration</dt>
          <dd data-typography="body">{formatDuration(run.durationMs)}</dd>
        </div>
        {run.result ? (
          <div>
            <dt data-typography="label">Result</dt>
            <dd data-typography="body">{run.result}</dd>
          </div>
        ) : null}
      </dl>
    </RunSection>
  );
}

function RunSection({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="section">
      <h2 data-typography="section-title" id={id}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function FailureDetails({
  run,
  eventMessage,
}: {
  readonly run: WorkflowRunDetail;
  readonly eventMessage: string | null;
}) {
  const showProjectedMessage = Boolean(
    run.errorMessage && run.errorMessage !== eventMessage,
  );
  return (
    <section aria-label="Failure details" className="workflow-run-failure">
      <h3 data-typography="component-title">Failure details</h3>
      <dl>
        {run.errorCode ? (
          <div>
            <dt data-typography="label">Error code</dt>
            <dd data-typography="code">{run.errorCode}</dd>
          </div>
        ) : null}
        {showProjectedMessage ? (
          <div>
            <dt data-typography="label">Message</dt>
            <dd data-typography="body">{run.errorMessage}</dd>
          </div>
        ) : null}
        <div>
          <dt data-typography="label">Retryable</dt>
          <dd data-typography="body">{run.retryable ? "Yes" : "No"}</dd>
        </div>
      </dl>
    </section>
  );
}

function RunTimeline({ run }: { readonly run: WorkflowRunDetail }) {
  const events = timelineEntries(run);
  return (
    <RunSection id="workflow-run-timeline-title" title="Timeline">
      {events.length === 0 ? (
        <Empty title="No lifecycle events recorded yet." />
      ) : (
        <ol aria-label="Workflow lifecycle" className="workflow-run-timeline">
          {events.map((event, index) => {
            const eventLabel = humanizeIdentifier(event.eventType);
            const eventMessage = event.message?.trim() || null;
            return (
              <li
                aria-label={eventLabel}
                className="workflow-run-timeline__event"
                data-event-status={event.status || "unknown"}
                data-synthetic={event.synthetic || undefined}
                key={`${event.eventType}-${event.occurredAt || "undated"}-${index}`}
              >
                <span
                  aria-hidden="true"
                  className="workflow-run-timeline__marker"
                />
                <div className="workflow-run-timeline__body">
                  <div className="workflow-run-timeline__heading">
                    <strong data-typography="component-title">
                      {eventLabel}
                    </strong>
                    <time
                      data-typography="metadata"
                      dateTime={event.occurredAt || undefined}
                    >
                      {event.occurredAt
                        ? formatDateTime(event.occurredAt)
                        : "Time not recorded"}
                    </time>
                  </div>
                  {event.synthetic ? (
                    <p
                      className="workflow-run-timeline__source"
                      data-typography="metadata"
                    >
                      Reconstructed from the run failure record because no
                      failed lifecycle event was available.
                    </p>
                  ) : null}
                  {eventMessage ? (
                    <p data-typography="body">{eventMessage}</p>
                  ) : null}
                  {event.ownsFailure ? (
                    <FailureDetails eventMessage={eventMessage} run={run} />
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </RunSection>
  );
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
          contentLabel="Workflow run timeline and details"
          header={
            <div className="workflow-run-workspace__header">
              <Link
                aria-label="Back to workflow runs"
                className={buttonVariants({
                  className: "workspace-back",
                  size: "sm",
                  variant: "ghost",
                })}
                data-typography="control"
                search={(prev) => prev}
                to="/runs"
              >
                <IconArrowLeft aria-hidden="true" size={16} stroke={1.9} />
                Runs
              </Link>
              <div className="workflow-run-workspace__summary">
                <div className="workflow-run-workspace__title">
                  <small data-typography="metadata">Workflow run</small>
                  <h1 data-typography="page-title">{workflowTitle(run)}</h1>
                  <p data-typography="body">
                    {run.dryRun ? "Dry run" : "Live"} · Started{" "}
                    {formatDateTime(run.startedAt)}
                  </p>
                </div>
                <RunStatusBadge status={run.status} />
              </div>
              <RunActions run={run} />
            </div>
          }
        >
          <div className="workflow-run-workspace__content">
            <RunTimeline run={run} />
            <RunMetadata run={run} />
          </div>
        </RouteWorkspace>
      ) : null}
    </div>
  );
}
