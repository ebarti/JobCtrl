import type {
  PipelineActiveItem,
  PipelineApproximateTaskQueue,
  PipelineCapacity,
  PipelineEta,
  PipelineExecutionCohortSummary,
  PipelineOperationalStage,
  PipelineOperationsFreshness,
  PipelineOperationsSnapshot,
  PipelineStageCounts,
  PipelineTaskQueueStats,
} from "@jobctrl/contracts";
import { IconAlertTriangle } from "@tabler/icons-react";
import { Fragment, type ReactNode } from "react";

import { CancelWorkflowRunButton } from "../../contexts/pipeline/components/CancelWorkflowRunButton.js";
import { StageTriggerPanel } from "../../contexts/pipeline/components/StageTriggerPanel.js";
import {
  etaLabel,
  formatSeconds,
  safeOperationalIdentifier,
  sentenceCase,
} from "../../contexts/pipeline/components/pipelineOperationsDisplay.js";
import { useStageTriggerStore } from "../../contexts/pipeline/stores/stage-trigger-store.js";
import { usePipelineOperationsQuery } from "../../contexts/operations/hooks/usePipelineOperationsQuery.js";
import { cn } from "../../shared/lib/cn.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "../../shared/ui/alert.js";
import { buttonVariants } from "../../shared/ui/button.js";
import { DisclosureSection } from "../../shared/ui/disclosure-section.js";
import { Empty } from "../../shared/ui/empty.js";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../shared/ui/card.js";
import {
  InspectorLedger,
  InspectorLedgerItem,
} from "../../shared/ui/inspector-ledger.js";
import { PageHead } from "../../shared/ui/page-head.js";
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "../../shared/ui/progress.js";
import { RouteWorkspace } from "../../shared/ui/route-workspace.js";
import { StatusBadge } from "../../shared/ui/status-badge.js";
import type { StatusTagTone } from "../../shared/ui/status-tokens.js";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../shared/ui/table.js";
import { ToolRow } from "../../shared/ui/tool-row.js";

const COUNT_FIELDS = [
  ["eligible", "Eligible"],
  ["waiting", "Waiting"],
  ["processing", "Processing"],
  ["succeeded", "Succeeded"],
  ["skipped", "Skipped"],
  ["blocked", "Blocked"],
  ["failed", "Failed"],
  ["exhausted", "Exhausted"],
  ["canceled", "Canceled"],
  ["needsVerification", "Needs verification"],
  ["stale", "Stale"],
  ["unknown", "Unknown"],
] as const;

const COHORT_FIELDS = [
  ["members", "Members"],
  ["planned", "Planned"],
  ["notEligible", "Not eligible"],
  ["pending", "Pending plan"],
  ["failedPlan", "Failed plan"],
  ["terminal", "Terminal"],
  ["remaining", "Remaining"],
] as const;

function statusTone(status: string): StatusTagTone {
  if (["available", "completed", "fresh", "succeeded"].includes(status)) {
    return "ok";
  }
  if (["failed", "unavailable"].includes(status)) return "danger";
  if (
    [
      "blocked",
      "calibrating",
      "completed_with_issues",
      "incomplete",
      "paused",
      "retrying",
      "stale",
      "unsupported",
    ].includes(status)
  ) {
    return "warn";
  }
  if (
    ["discovering", "draining", "in_progress", "processing", "recovering"].includes(
      status,
    )
  ) {
    return "info";
  }
  return "muted";
}

type RecoveryProjectionCoverage = Extract<
  PipelineOperationsSnapshot["projectionCoverage"],
  { readonly status: "incomplete" | "recovering" | "retrying" }
>;

function projectionReady(snapshot: PipelineOperationsSnapshot): boolean {
  return snapshot.execution === null
    ? snapshot.projectionCoverage === null
    : snapshot.projectionCoverage?.status === "ready";
}

function recoveryCoverage(
  snapshot: PipelineOperationsSnapshot,
): RecoveryProjectionCoverage | null {
  const coverage = snapshot.projectionCoverage;
  return coverage?.status === "incomplete" ||
    coverage?.status === "recovering" ||
    coverage?.status === "retrying"
    ? coverage
    : null;
}

function recoveryStateLabel(snapshot: PipelineOperationsSnapshot): string {
  return snapshot.projectionCoverage?.status === "incomplete"
    ? "Historical run incomplete"
    : snapshot.projectionCoverage?.status === "retrying"
    ? "Repair retry scheduled"
    : snapshot.projectionCoverage?.status === "recovering" || snapshot.execution
      ? "Restoring history"
      : "No selected execution";
}

function canSafelyPrepareNewDiscoverRun(
  snapshot: PipelineOperationsSnapshot,
): boolean {
  return (
    snapshot.activeItemsTotal === 0 &&
    snapshot.capacity.status === "available" &&
    snapshot.capacity.activeSlots === 0
  );
}

function PipelineStatus({
  children,
  status,
}: {
  readonly children?: ReactNode;
  readonly status: string;
}) {
  return (
    <StatusBadge icon={false} tone={statusTone(status)}>
      {children ?? sentenceCase(status)}
    </StatusBadge>
  );
}

function completedCount(counts: PipelineStageCounts): number {
  return (
    counts.succeeded +
    counts.skipped +
    counts.blocked +
    counts.failed +
    counts.exhausted +
    counts.canceled +
    counts.needsVerification
  );
}

function issueCount(counts: PipelineStageCounts): number {
  return (
    counts.blocked +
    counts.failed +
    counts.exhausted +
    counts.needsVerification +
    counts.stale +
    counts.unknown
  );
}

function activeCount(counts: PipelineStageCounts): number {
  return counts.waiting + counts.processing;
}

function trackedCount(counts: PipelineStageCounts): number {
  return Math.max(
    counts.eligible,
    activeCount(counts) + completedCount(counts) + counts.stale + counts.unknown,
  );
}

function stageProgress(counts: PipelineStageCounts): number {
  const total = trackedCount(counts);
  return total === 0 ? 0 : Math.min(100, Math.round((completedCount(counts) / total) * 100));
}

function stageStatus(counts: PipelineStageCounts): string {
  if (issueCount(counts) > 0) return "blocked";
  if (counts.processing > 0) return "processing";
  if (counts.waiting > 0) return "pending";
  if (trackedCount(counts) > 0 && completedCount(counts) >= trackedCount(counts)) {
    return "completed";
  }
  return "idle";
}

function CountSummary({ counts }: { readonly counts: PipelineStageCounts }) {
  const active = counts.waiting + counts.processing;
  const issues = issueCount(counts);

  return (
    <span className="pipeline-count-summary">
      <span>
        <b>{active}</b> active
      </span>
      <span>
        <b>{counts.succeeded}</b> done
      </span>
      {issues > 0 ? (
        <span>
          <b>{issues}</b> attention
        </span>
      ) : null}
    </span>
  );
}

function CountLedger({
  counts,
  label,
}: {
  readonly counts: PipelineStageCounts;
  readonly label: string;
}) {
  return (
    <InspectorLedger aria-label={label} className="pipeline-compact-ledger">
      {COUNT_FIELDS.map(([field, fieldLabel]) => (
        <InspectorLedgerItem
          key={field}
          label={fieldLabel}
          value={counts[field]}
        />
      ))}
    </InspectorLedger>
  );
}

function CohortLedger({
  cohort,
  label,
}: {
  readonly cohort: PipelineExecutionCohortSummary;
  readonly label: string;
}) {
  return (
    <section className="pipeline-inspector-group" aria-label={label}>
      <h3>{label}</h3>
      <InspectorLedger className="pipeline-compact-ledger">
        {COHORT_FIELDS.map(([field, fieldLabel]) => (
          <InspectorLedgerItem
            key={field}
            label={fieldLabel}
            value={cohort[field]}
          />
        ))}
      </InspectorLedger>
    </section>
  );
}

function EtaLedger({
  eta,
  label,
}: {
  readonly eta: PipelineEta;
  readonly label: string;
}) {
  return (
    <InspectorLedger aria-label={label} className="pipeline-compact-ledger">
      <InspectorLedgerItem label="Status" value={sentenceCase(eta.status)} />
      {eta.status === "available" ? (
        <>
          <InspectorLedgerItem label="Low" value={formatSeconds(eta.lowSeconds)} />
          <InspectorLedgerItem label="High" value={formatSeconds(eta.highSeconds)} />
          <InspectorLedgerItem
            label="Confidence"
            value={sentenceCase(eta.confidence)}
          />
          <InspectorLedgerItem label="Basis" value={sentenceCase(eta.basis)} />
          <InspectorLedgerItem label="Samples" value={eta.sampleSize} />
          <InspectorLedgerItem label="Caveat" value={eta.caveat ?? "None"} />
        </>
      ) : null}
      {eta.status === "calibrating" ? (
        <>
          <InspectorLedgerItem
            label="Completed samples"
            value={eta.completedSamples}
          />
          <InspectorLedgerItem
            label="Minimum samples"
            value={eta.minimumSamples}
          />
          <InspectorLedgerItem label="Reason" value={sentenceCase(eta.reason)} />
        </>
      ) : null}
      {eta.status === "paused" ||
      eta.status === "stale" ||
      eta.status === "unavailable" ? (
        <InspectorLedgerItem label="Reason" value={sentenceCase(eta.reason)} />
      ) : null}
      <InspectorLedgerItem label="As of" value={formatDateTime(eta.asOf)} />
    </InspectorLedger>
  );
}

function QueueStats({
  label,
  stats,
}: {
  readonly label: string;
  readonly stats: PipelineTaskQueueStats;
}) {
  return (
    <section className="pipeline-inspector-group" aria-label={`${label} task queue`}>
      <h4>{label}</h4>
      <InspectorLedger className="pipeline-compact-ledger">
        <InspectorLedgerItem label="Pollers" value={stats.pollerCount} />
        <InspectorLedgerItem
          label="Approximate backlog"
          value={stats.approximateBacklogCount}
        />
        <InspectorLedgerItem
          label="Approximate backlog age"
          value={formatSeconds(stats.approximateBacklogAgeSeconds)}
        />
        <InspectorLedgerItem label="Add rate" value={`${stats.tasksAddRate}/sec`} />
        <InspectorLedgerItem
          label="Dispatch rate"
          value={`${stats.tasksDispatchRate}/sec`}
        />
      </InspectorLedger>
    </section>
  );
}

function TaskQueueLedger({
  queue,
}: {
  readonly queue: PipelineApproximateTaskQueue;
}) {
  return (
    <section className="pipeline-inspector-group" aria-label="Task queue facts">
      <h3>Task queue</h3>
      <InspectorLedger className="pipeline-compact-ledger">
        <InspectorLedgerItem label="Observation" value={sentenceCase(queue.status)} />
        <InspectorLedgerItem label="Observed" value={formatDateTime(queue.observedAt)} />
        {queue.status === "stale" ? (
          <InspectorLedgerItem
            label="Last known status"
            value={sentenceCase(queue.lastKnownStatus)}
          />
        ) : null}
        {queue.status === "unsupported" || queue.status === "unavailable" ? (
          <InspectorLedgerItem label="Reason code" value={queue.reasonCode} />
        ) : null}
      </InspectorLedger>
      {queue.status === "available" ? (
        <div className="pipeline-queue-ledgers">
          <QueueStats label="Workflow" stats={queue.workflow} />
          <QueueStats label="Activity" stats={queue.activity} />
        </div>
      ) : null}
    </section>
  );
}

function CapacityLedger({
  capacity,
}: {
  readonly capacity: PipelineCapacity;
}) {
  return (
    <div className="pipeline-capacity-ledger">
      <section className="pipeline-inspector-group" aria-label="Worker capacity facts">
        <h3>Worker capacity</h3>
        <InspectorLedger className="pipeline-compact-ledger">
          <InspectorLedgerItem label="Status" value={sentenceCase(capacity.status)} />
          <InspectorLedgerItem label="Observed" value={formatDateTime(capacity.asOf)} />
          <InspectorLedgerItem
            label="Stale after"
            value={`${capacity.staleAfterSeconds} sec`}
          />
          <InspectorLedgerItem
            label="Task queue"
            value={capacity.taskQueue ?? "Not reported"}
          />
          {capacity.status === "available" ? (
            <>
              <InspectorLedgerItem label="Pool" value={sentenceCase(capacity.kind)} />
              <InspectorLedgerItem
                label="Fresh workers"
                value={capacity.freshWorkerCount}
              />
              <InspectorLedgerItem
                label="Stale workers"
                value={capacity.staleWorkerCount}
              />
              <InspectorLedgerItem
                label="Invalid workers"
                value={capacity.invalidWorkerCount}
              />
              <InspectorLedgerItem
                label="Configured slots"
                value={capacity.configuredSlots}
              />
              <InspectorLedgerItem label="Active slots" value={capacity.activeSlots} />
              <InspectorLedgerItem
                label="Available slots"
                value={capacity.availableSlots}
              />
              <InspectorLedgerItem
                label="Executor threads"
                value={capacity.executorThreads}
              />
              <InspectorLedgerItem
                label="Slot saturation"
                value={
                  capacity.slotSaturation === null
                    ? "Not available"
                    : `${Math.round(capacity.slotSaturation * 100)}%`
                }
              />
              {capacity.kind === "shared_activity_pool_with_internal_parallelism" ? (
                <InspectorLedgerItem
                  label="Internal concurrency"
                  value={capacity.internalParallelism}
                />
              ) : null}
            </>
          ) : (
            <InspectorLedgerItem label="Reason" value={capacity.reason} />
          )}
        </InspectorLedger>
      </section>
      <TaskQueueLedger queue={capacity.approximateTaskQueue} />
    </div>
  );
}

function FreshnessLedger({
  freshness,
}: {
  readonly freshness: PipelineOperationsFreshness;
}) {
  return (
    <section className="pipeline-inspector-group" aria-label="Telemetry freshness">
      <h3>Freshness</h3>
      <InspectorLedger className="pipeline-compact-ledger">
        <InspectorLedgerItem
          label="Telemetry status"
          value={sentenceCase(freshness.status)}
        />
        <InspectorLedgerItem label="As of" value={formatDateTime(freshness.asOf)} />
        <InspectorLedgerItem
          label="Stale after"
          value={`${freshness.staleAfterSeconds} sec`}
        />
        {freshness.status === "fresh" ? null : (
          <InspectorLedgerItem label="Freshness reason" value={freshness.reason} />
        )}
      </InspectorLedger>
    </section>
  );
}

function scopeLabel(scope: PipelineOperationalStage["scope"]): string {
  switch (scope) {
    case "current_execution":
      return "Current execution";
    case "execution_sweep":
      return "Execution sweep";
    case "global_outside_execution":
      return "Global outside execution";
  }
}

function scopeCompactLabel(scope: PipelineOperationalStage["scope"]): string {
  return scope === "global_outside_execution" ? "Global backlog" : scopeLabel(scope);
}

function stageTrackedCount(stage: PipelineOperationalStage): number {
  const existingBacklog =
    stage.existingBacklog.kind === "domain_jobs"
      ? trackedCount(stage.existingBacklog.counts)
      : 0;
  return trackedCount(stage.currentExecution) + existingBacklog;
}

function stageEtaDisplay(stage: PipelineOperationalStage): string {
  return stageTrackedCount(stage) === 0
    ? "No tracked work"
    : etaLabel(stage.eta);
}

function StageRows({
  recoveryLabel,
  stage,
  trackingReady,
}: {
  readonly recoveryLabel: string;
  readonly stage: PipelineOperationalStage;
  readonly trackingReady: boolean;
}) {
  const scope = scopeLabel(stage.scope);

  return (
    <Fragment>
      <TableRow>
        <TableCell className="pipeline-stage-name">
          <strong>{stage.label}</strong>
          <code>{stage.stage}</code>
        </TableCell>
        <TableCell>
          <PipelineStatus status={stage.scope === "current_execution" ? "in_progress" : "pending"}>
            {scopeCompactLabel(stage.scope)}
          </PipelineStatus>
        </TableCell>
        <TableCell>
          {trackingReady ? (
            <CountSummary counts={stage.currentExecution} />
          ) : (
            <span className="pipeline-muted-copy">{recoveryLabel}</span>
          )}
        </TableCell>
        <TableCell>
          {stage.existingBacklog.kind === "domain_jobs" ? (
            <CountSummary counts={stage.existingBacklog.counts} />
          ) : (
            <span className="pipeline-muted-copy">
              {sentenceCase(stage.existingBacklog.reason)}
            </span>
          )}
        </TableCell>
        <TableCell className="pipeline-stage-runtime">
          <strong>
            {trackingReady ? stageEtaDisplay(stage) : recoveryLabel}
          </strong>
        </TableCell>
        <TableCell className="pipeline-stage-observed">
          <time dateTime={stage.asOf}>{formatDateTime(stage.asOf)}</time>
        </TableCell>
      </TableRow>
      <TableRow className="pipeline-stage-detail-row">
        <TableCell colSpan={6}>
          <DisclosureSection
            className="pipeline-stage-details"
            collapsedSummary={
              trackingReady ? stageEtaDisplay(stage) : recoveryLabel
            }
            defaultOpen={false}
            description="Outcomes, backlog, and ETA provenance for this row. Global worker and queue capacity is reported once above."
            headingLevel={4}
            title={`Inspect ${stage.label} — ${scope}`}
          >
            <div className="pipeline-stage-details__grid">
              <section className="pipeline-inspector-group">
                <h4>Scoped outcomes</h4>
                {trackingReady ? (
                  <CountLedger
                    counts={stage.currentExecution}
                    label={`${stage.label} scoped outcomes`}
                  />
                ) : (
                  <Empty title="Exact scoped outcomes are unavailable for this execution." />
                )}
              </section>
              <section className="pipeline-inspector-group">
                <h4>Existing backlog</h4>
                {stage.existingBacklog.kind === "domain_jobs" ? (
                  <CountLedger
                    counts={stage.existingBacklog.counts}
                    label={`${stage.label} existing backlog`}
                  />
                ) : (
                  <InspectorLedger>
                    <InspectorLedgerItem label="Kind" value="Not separate" />
                    <InspectorLedgerItem
                      label="Reason"
                      value={stage.existingBacklog.reason}
                    />
                  </InspectorLedger>
                )}
              </section>
              <section className="pipeline-inspector-group">
                <h4>Completion estimate</h4>
                {trackingReady && stageTrackedCount(stage) > 0 ? (
                  <EtaLedger eta={stage.eta} label={`${stage.label} ETA facts`} />
                ) : (
                  <Empty
                    title={
                      trackingReady
                        ? "No tracked work is available for an ETA."
                        : "The estimate will appear after pipeline history restoration completes."
                    }
                  />
                )}
              </section>
            </div>
          </DisclosureSection>
        </TableCell>
      </TableRow>
    </Fragment>
  );
}

function PipelineStageCard({
  recoveryLabel,
  stage,
  trackingReady,
}: {
  readonly recoveryLabel: string;
  readonly stage: PipelineOperationalStage;
  readonly trackingReady: boolean;
}) {
  const counts = stage.currentExecution;
  const progress = stageProgress(counts);
  const status = stageStatus(counts);
  const hasProgressDenominator = trackedCount(counts) > 0;

  return (
    <Card
      aria-label={`${stage.label} stage`}
      className="pipeline-stage-card"
      role="region"
      size="sm"
    >
      <CardHeader>
        <CardTitle>{stage.label}</CardTitle>
        <CardDescription>{sentenceCase(stage.stage)}</CardDescription>
        <CardAction>
          <PipelineStatus status={trackingReady ? status : "recovering"}>
            {trackingReady ? undefined : recoveryLabel}
          </PipelineStatus>
        </CardAction>
      </CardHeader>
      <CardContent className="pipeline-stage-card__content">
        {trackingReady ? (
          <>
            <dl
              aria-label={`${stage.label} stage summary`}
              className="pipeline-stage-card__facts"
            >
              <div>
                <dt>Active</dt>
                <dd>{activeCount(counts)}</dd>
              </div>
              <div>
                <dt>Waiting</dt>
                <dd>{counts.waiting}</dd>
              </div>
              <div>
                <dt>Processing</dt>
                <dd>{counts.processing}</dd>
              </div>
              <div>
                <dt>Terminal</dt>
                <dd>{completedCount(counts)}</dd>
              </div>
              <div>
                <dt>Attention</dt>
                <dd>{issueCount(counts)}</dd>
              </div>
            </dl>
            {hasProgressDenominator ? (
              <Progress value={progress}>
                <ProgressLabel>Stage progress</ProgressLabel>
                <ProgressValue>{progress}% terminal</ProgressValue>
              </Progress>
            ) : null}
            {hasProgressDenominator ? (
              <div className="pipeline-stage-card__eta">
                <span>ETA</span>
                <strong>{etaLabel(stage.eta)}</strong>
              </div>
            ) : null}
            <DisclosureSection
              className="pipeline-stage-state-details"
              collapsedSummary="All recorded outcome states"
              defaultOpen={false}
              description="Exact counts from the selected-execution projection, including failures and cancellations."
              headingLevel={4}
              title="All stage outcomes"
            >
              <CountLedger
                counts={counts}
                label={`${stage.label} current-execution outcome counts`}
              />
            </DisclosureSection>
          </>
        ) : (
          <p className="pipeline-stage-card__recovery-copy">
            Exact stage counts and estimates will appear automatically when history
            restoration completes.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

interface ExecutionFailureCopy {
  readonly description: string;
  readonly title: string;
}

function executionFailureCopy(
  phase: "completed_with_issues" | "failed",
  errorCode: string | null,
): ExecutionFailureCopy {
  if (phase === "completed_with_issues") {
    if (errorCode === "source_retry_exhausted") {
      return {
        title: "Discovery completed with source issues",
        description:
          "One or more source tasks exhausted their automatic retries. Review the exact stage outcomes below to see what completed and what needs another pass. Once active-work status confirms nothing is running, use Set up a new Discover run to retry unfinished source work.",
      };
    }

    const reportedReason = errorCode
      ? `Reported reason: ${sentenceCase(errorCode)}. `
      : "";
    return {
      title: "Discovery completed with issues",
      description: `${reportedReason}Review the exact stage outcomes below. Once active-work status confirms nothing is running, use Set up a new Discover run to retry unfinished work.`,
    };
  }

  if (errorCode === "reconciled_not_found") {
    return {
      title: "Previous discovery history is unavailable",
      description:
        "The previous Temporal workflow history can no longer be found, so that run cannot resume. Start Discover again below to create a new run when no active work remains. New runs use persistent local history and survive normal app restarts.",
    };
  }

  const reportedReason = errorCode
    ? `Reported reason: ${sentenceCase(errorCode)}. `
    : "";
  return {
    title: "Discovery stopped before completion",
    description: `${reportedReason}Review the active-work status and technical details, then start Discover again below when it is safe to do so.`,
  };
}

function failedExecutionActivityCopy(activeItemsTotal: number | null): string {
  if (activeItemsTotal === 0) return "No work is running.";
  if (activeItemsTotal === null) {
    return "The runtime inventory is unavailable, so JobCtrl cannot confirm whether work remains active.";
  }
  return `${activeItemsTotal} active work ${activeItemsTotal === 1 ? "item remains" : "items remain"}. Review active work before restarting discovery.`;
}

function PipelineExecutionNotice({
  onPrepareNewDiscoverRun,
  snapshot,
}: {
  readonly onPrepareNewDiscoverRun: () => void;
  readonly snapshot: PipelineOperationsSnapshot;
}) {
  if (!projectionReady(snapshot)) return null;

  const execution = snapshot.execution;
  if (
    !execution ||
    (execution.phase !== "failed" &&
      execution.phase !== "completed_with_issues")
  ) {
    return null;
  }

  const copy = executionFailureCopy(execution.phase, execution.errorCode);
  const activityCopy = failedExecutionActivityCopy(snapshot.activeItemsTotal);
  const canStartNewRun = snapshot.activeItemsTotal === 0;
  return (
    <div className="pipeline-recovery-notice">
      <Alert
        className="pipeline-recovery-alert"
        variant={execution.phase === "failed" ? "destructive" : "default"}
      >
        <AlertTitle>{copy.title}</AlertTitle>
        <AlertDescription>
          {activityCopy} {copy.description}
        </AlertDescription>
        {canStartNewRun ? (
          <AlertAction>
            <a
              className={buttonVariants({ size: "sm" })}
              href="#pipeline-actions"
              onClick={onPrepareNewDiscoverRun}
            >
              Set up a new Discover run
            </a>
          </AlertAction>
        ) : null}
      </Alert>
      <DisclosureSection
        collapsedSummary="Workflow status and reason code"
        defaultOpen={false}
        description="Raw execution identifiers are kept here for troubleshooting."
        headingLevel={3}
        title="Technical details"
      >
        <InspectorLedger>
          <InspectorLedgerItem label="Workflow status" value={sentenceCase(execution.workflowStatus)} />
          <InspectorLedgerItem label="Reason code" value={execution.errorCode ?? "Not reported"} />
          <InspectorLedgerItem label="Workflow id" value={execution.discoverWorkflowId} />
          <InspectorLedgerItem label="Temporal run id" value={execution.discoverRunId} />
        </InspectorLedger>
      </DisclosureSection>
    </div>
  );
}

function PipelineOverviewFact({
  description,
  label,
  value,
}: {
  readonly description: string;
  readonly label: string;
  readonly value: ReactNode;
}) {
  return (
    <Card aria-label={label} className="pipeline-overview-fact" role="region" size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle>{value}</CardTitle>
      </CardHeader>
      <CardContent>{description}</CardContent>
    </Card>
  );
}

function humanStageLabel(
  snapshot: PipelineOperationsSnapshot,
  stageId: string,
): string {
  return (
    snapshot.stages.find((stage) => stage.stage === stageId)?.label ??
    sentenceCase(stageId)
  );
}

function activeStageSummary(snapshot: PipelineOperationsSnapshot): string {
  if (snapshot.activeStageCounts === null) return "Stage breakdown unavailable";
  if (snapshot.activeStageCounts.length === 0) {
    return snapshot.activeItemsTotal && snapshot.activeItemsTotal > 0
      ? `${snapshot.activeItemsTotal} unclassified runtime ${
          snapshot.activeItemsTotal === 1 ? "activity" : "activities"
        }`
      : "No active stages";
  }
  return snapshot.activeStageCounts
    .map(
      ({ count, stage }) => `${humanStageLabel(snapshot, stage)} ${count}`,
    )
    .join(" · ");
}

function queueBacklogSummary(capacity: PipelineCapacity): {
  readonly description: string;
  readonly value: string;
} {
  const queue = capacity.approximateTaskQueue;
  if (queue.status !== "available") {
    return {
      description: "Temporal queue telemetry is not available",
      value: "Unavailable",
    };
  }

  const backlog =
    queue.workflow.approximateBacklogCount +
    queue.activity.approximateBacklogCount;
  const oldestAgeSeconds = Math.max(
    queue.workflow.approximateBacklogAgeSeconds,
    queue.activity.approximateBacklogAgeSeconds,
  );
  return {
    description: `Oldest queued task ${formatSeconds(oldestAgeSeconds)}`,
    value: `${backlog} queued`,
  };
}

function ProjectionCoverageNotice({
  onPrepareNewDiscoverRun,
  snapshot,
}: {
  readonly onPrepareNewDiscoverRun: () => void;
  readonly snapshot: PipelineOperationsSnapshot;
}) {
  const coverage = recoveryCoverage(snapshot);
  if (!coverage) return null;
  const isRetrying = coverage.status === "retrying";
  const isIncomplete = coverage.status === "incomplete";
  const canStartNewRun = isIncomplete && canSafelyPrepareNewDiscoverRun(snapshot);
  const membershipProgress =
    coverage.expectedMembershipCount === null
      ? `${coverage.persistedMembershipCount} membership records restored so far`
      : `${coverage.persistedMembershipCount} of ${coverage.expectedMembershipCount} membership records restored`;
  const stepProgress =
    coverage.expectedStepCount === null
      ? `${coverage.persistedStepCount} stage records restored so far`
      : `${coverage.persistedStepCount} of ${coverage.expectedStepCount} stage records restored`;
  const errorCopy =
    isRetrying && coverage.errorCode
      ? ` Last safe repair result: ${sentenceCase(coverage.errorCode)}.`
      : "";

  return (
    <Alert
      className={cn(
        "pipeline-coverage-alert",
        isRetrying && "pipeline-coverage-alert--retrying",
        isIncomplete && "pipeline-coverage-alert--incomplete",
      )}
    >
      <IconAlertTriangle aria-hidden="true" />
      <AlertTitle>
        {isIncomplete
          ? "Historical pipeline record is incomplete"
          : isRetrying
          ? "Pipeline history repair will retry automatically"
          : "Restoring pipeline history"}
      </AlertTitle>
      <AlertDescription>
        {isIncomplete ? (
          <>
            This legacy run ended before Temporal recorded its complete preparation
            target set. JobCtrl preserved every exact record it can prove: {membershipProgress};{" "}
            {stepProgress}. Selected-run percentages and estimates stay hidden because
            the missing historical targets cannot be reconstructed safely. This closed
            run will not be retried automatically. Global worker, queue, and activity
            facts remain live below.
          </>
        ) : (
          <>
            JobCtrl is rebuilding exact selected-run ownership from durable Temporal
            history: {membershipProgress}; {stepProgress}. Selected-run percentages and
            estimates stay hidden until that proof is complete.{errorCopy} Recovery runs
            at worker startup and on every worker heartbeat; no manual restart is needed.
            Global worker, queue, and activity facts remain live below.
          </>
        )}
      </AlertDescription>
      {canStartNewRun ? (
        <AlertAction>
          <a
            className={buttonVariants({ size: "sm" })}
            href="#pipeline-actions"
            onClick={onPrepareNewDiscoverRun}
          >
            Set up a new Discover run
          </a>
        </AlertAction>
      ) : null}
    </Alert>
  );
}

function PipelineLiveFlow({
  onPrepareNewDiscoverRun,
  snapshot,
}: {
  readonly onPrepareNewDiscoverRun: () => void;
  readonly snapshot: PipelineOperationsSnapshot;
}) {
  const trackingReady = projectionReady(snapshot);
  const currentStages = trackingReady
    ? snapshot.stages.filter((stage) => stage.scope === "current_execution")
    : [];
  const capacity = snapshot.capacity;
  const isActive =
    snapshot.execution?.workflowStatus === "in_progress" &&
    (snapshot.execution.phase === "discovering" ||
      snapshot.execution.phase === "draining");
  const activeInventory = snapshot.activeItemsTotal;
  const queueBacklog = queueBacklogSummary(capacity);

  return (
    <section className="pipeline-live-flow" aria-labelledby="pipeline-live-flow-title">
      <div className="pipeline-live-flow__heading">
        <div>
          <h2 id="pipeline-live-flow-title">Live pipeline</h2>
          <p>
            {trackingReady
              ? "Current discovery stages, shared workers, and work that needs attention."
              : "Shared workers, queue pressure, and active runtime work remain live during recovery."}
          </p>
        </div>
        {isActive && snapshot.execution?.discoverWorkflowId ? (
          <CancelWorkflowRunButton
            ariaLabel="Stop discovery"
            className="pipeline-stop-action"
            label="Stop discovery"
            runId={snapshot.execution.discoverWorkflowId}
          />
        ) : null}
      </div>
      {trackingReady ? (
        <PipelineExecutionNotice
          onPrepareNewDiscoverRun={onPrepareNewDiscoverRun}
          snapshot={snapshot}
        />
      ) : null}
      <ProjectionCoverageNotice
        onPrepareNewDiscoverRun={onPrepareNewDiscoverRun}
        snapshot={snapshot}
      />
      <div className="pipeline-overview-grid">
        <PipelineOverviewFact
          description={
            capacity.status === "available"
              ? `${capacity.staleWorkerCount} stale · ${capacity.invalidWorkerCount} invalid`
              : capacity.reason
          }
          label="Workers online"
          value={capacity.status === "available" ? capacity.freshWorkerCount : "Unavailable"}
        />
        <PipelineOverviewFact
          description={
            capacity.status === "available"
              ? `${capacity.availableSlots} available in the shared activity pool`
              : "Runtime capacity has not been reported"
          }
          label="Worker slots in use"
          value={
            capacity.status === "available"
              ? `${capacity.activeSlots} of ${capacity.configuredSlots}`
              : "Unavailable"
          }
        />
        <PipelineOverviewFact
          description={`${activeStageSummary(snapshot)}${
            snapshot.activeItemsTruncated ? " · Partial inventory" : ""
          }`}
          label="Active work"
          value={activeInventory === 0 ? "No active work" : activeInventory ?? "Unknown"}
        />
        <PipelineOverviewFact
          description={queueBacklog.description}
          label="Queue backlog"
          value={queueBacklog.value}
        />
      </div>
      {trackingReady ? (
        currentStages.length > 0 ? (
          <div className="pipeline-stage-card-grid">
            {currentStages.map((stage, index) => (
              <PipelineStageCard
                key={`${stage.scope}-${stage.stage}-${index}`}
                recoveryLabel="Restoring history"
                stage={stage}
                trackingReady
              />
            ))}
          </div>
        ) : (
          <Empty title="No current-execution stages are available." />
        )
      ) : null}
    </section>
  );
}

function PipelineBacklogDiagnostics({
  snapshot,
}: {
  readonly snapshot: PipelineOperationsSnapshot;
}) {
  const scopes = ["execution_sweep", "global_outside_execution"] as const;
  const secondaryRows = snapshot.stages.filter(
    (stage) => stage.scope !== "current_execution",
  );
  const trackingReady = projectionReady(snapshot);
  const recoveryLabel = recoveryStateLabel(snapshot);

  return (
    <DisclosureSection
      className="pipeline-stage-ledger"
      collapsedSummary={`${secondaryRows.length} detailed rows`}
      defaultOpen={false}
      description="Execution sweep, backlog outside this run, and ETA provenance. Global worker and queue telemetry is reported once above."
      title="Backlog and diagnostics"
    >
      {secondaryRows.length > 0 ? (
        <div className="pipeline-scope-ledgers">
          {scopes.map((scope) => {
            const rows = snapshot.stages.filter((stage) => stage.scope === scope);
            if (rows.length === 0) return null;
            const label = scopeLabel(scope);

            return (
              <section
                aria-label={`${label} ledger table`}
                className="pipeline-scope-ledger"
                key={scope}
                tabIndex={0}
              >
                <div className="pipeline-scope-ledger__heading">
                  <h3>{label}</h3>
                  <span>{rows.length} stages</span>
                </div>
                <Table>
                  <TableCaption className="sr-only">
                    {label} stage state, existing backlog, ETA, and observation
                    time.
                  </TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Stage</TableHead>
                      <TableHead>Scope</TableHead>
                      <TableHead>Current execution</TableHead>
                      <TableHead>Existing backlog</TableHead>
                      <TableHead>ETA</TableHead>
                      <TableHead>Observed</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((stage, index) => (
                      <StageRows
                        key={`${stage.scope}-${stage.stage}-${index}`}
                        recoveryLabel={recoveryLabel}
                        stage={stage}
                        trackingReady={
                          trackingReady ||
                          stage.scope === "global_outside_execution"
                        }
                      />
                    ))}
                  </TableBody>
                </Table>
              </section>
            );
          })}
        </div>
      ) : (
        <Empty title="No sweep or global backlog rows are available." />
      )}
    </DisclosureSection>
  );
}

function PipelineSources({
  snapshot,
}: {
  readonly snapshot: PipelineOperationsSnapshot;
}) {
  const sources = snapshot.sourceFamilies;
  const reconciliation = snapshot.reconciliation;
  const trackingReady = projectionReady(snapshot);
  const recoveryLabel = recoveryStateLabel(snapshot);
  const completion =
    sources && sources.planned > 0
      ? Math.min(
          100,
          Math.round((completedCount(sources.counts) / sources.planned) * 100),
        )
      : 0;

  return (
    <DisclosureSection
      className="pipeline-source-ledger"
      collapsedSummary={
        !trackingReady
          ? recoveryLabel
          : sources
          ? `${sources.counts.succeeded}/${sources.planned} source families succeeded`
          : "Source plan unavailable"
      }
      description="Discovery intake and the two post-source reconciliation steps are reported independently."
      title="Source families and reconciliation"
    >
      <div className="pipeline-source-reconciliation">
        <section className="pipeline-ledger-panel" aria-labelledby="source-family-title">
          <div className="pipeline-ledger-panel__heading">
            <div>
              <h3 id="source-family-title">Source-family plan</h3>
              <p>Parallel source work within the selected discovery execution.</p>
            </div>
            {sources && trackingReady ? (
              <PipelineStatus
                status={
                  sources.counts.processing > 0
                    ? "processing"
                    : completion === 100
                      ? "completed"
                      : "pending"
                }
              >
                {sources.counts.succeeded}/{sources.planned} succeeded
              </PipelineStatus>
            ) : null}
          </div>
          {sources && trackingReady ? (
            <>
              {sources.planned > 0 ? (
                <Progress value={completion}>
                  <ProgressLabel>Source-family progress</ProgressLabel>
                  <ProgressValue>{completion}% terminal</ProgressValue>
                </Progress>
              ) : null}
              <CountSummary counts={sources.counts} />
              <CountLedger counts={sources.counts} label="Source-family outcomes" />
              <section className="pipeline-inspector-group">
                <h4>Source-family estimate</h4>
                <EtaLedger eta={sources.eta} label="Source-family ETA facts" />
              </section>
              <p className="pipeline-observed-copy">
                Observed <time dateTime={sources.asOf}>{formatDateTime(sources.asOf)}</time>
              </p>
            </>
          ) : !trackingReady ? (
            <Empty title="Source-family history is being restored automatically." />
          ) : (
            <Empty title="No source-family plan is available for the selected execution." />
          )}
        </section>
        <section className="pipeline-ledger-panel" aria-labelledby="reconciliation-title">
          <div className="pipeline-ledger-panel__heading">
            <div>
              <h3 id="reconciliation-title">Reconciliation</h3>
              <p>Exactly two post-source operations, never additional source families.</p>
            </div>
            {reconciliation && trackingReady ? (
              <PipelineStatus status="in_progress">2 steps</PipelineStatus>
            ) : null}
          </div>
          {reconciliation && trackingReady ? (
            <>
              <section className="pipeline-inspector-group">
                <h4>Enrichment pass</h4>
                <CountSummary counts={reconciliation.enrichment} />
                <CountLedger
                  counts={reconciliation.enrichment}
                  label="Enrichment pass outcomes"
                />
              </section>
              <section className="pipeline-inspector-group">
                <h4>Preparation fanout</h4>
                <CountSummary counts={reconciliation.preparationFanout} />
                <CountLedger
                  counts={reconciliation.preparationFanout}
                  label="Preparation fanout outcomes"
                />
              </section>
              <p className="pipeline-observed-copy">
                Observed{ }
                <time dateTime={reconciliation.asOf}>
                  {formatDateTime(reconciliation.asOf)}
                </time>
              </p>
            </>
          ) : !trackingReady ? (
            <Empty title="Reconciliation history is being restored automatically." />
          ) : (
            <Empty title="No reconciliation projection is available for the selected execution." />
          )}
        </section>
      </div>
    </DisclosureSection>
  );
}

function ActiveItemTitle({
  item,
  snapshot,
}: {
  readonly item: PipelineActiveItem;
  readonly snapshot: PipelineOperationsSnapshot;
}) {
  switch (item.kind) {
    case "resolved_job":
      return item.title ?? item.company ?? safeOperationalIdentifier(item.jobKey);
    case "source_family":
      return item.sourceFamily;
    case "orchestration":
      return item.operation;
    case "unresolved_runtime_activity":
      return item.stage
        ? humanStageLabel(snapshot, item.stage)
        : safeOperationalIdentifier(item.opaqueId);
  }
}

function ActiveItemLedger({
  item,
  snapshot,
}: {
  readonly item: PipelineActiveItem;
  readonly snapshot: PipelineOperationsSnapshot;
}) {
  return (
    <li className="pipeline-active-item">
      <div className="pipeline-active-item__heading">
        <div>
          <h3>
            <ActiveItemTitle item={item} snapshot={snapshot} />
          </h3>
          <span>{item.activityType}</span>
        </div>
        <PipelineStatus status="in_progress">Attempt {item.attempt}</PipelineStatus>
      </div>
      <InspectorLedger className="pipeline-compact-ledger">
        <InspectorLedgerItem label="Kind" value={sentenceCase(item.kind)} />
        <InspectorLedgerItem label="Activity" value={item.activityType} />
        <InspectorLedgerItem label="Workflow" value={item.workflowId ?? "Not reported"} />
        <InspectorLedgerItem label="Execution" value={item.executionId ?? "Not reported"} />
        <InspectorLedgerItem label="Attempt" value={item.attempt} />
        <InspectorLedgerItem label="Started" value={formatDateTime(item.startedAt)} />
        {item.kind === "resolved_job" ? (
          <>
            <InspectorLedgerItem
              label="Job key"
              value={safeOperationalIdentifier(item.jobKey)}
            />
            <InspectorLedgerItem label="Title" value={item.title ?? "Not reported"} />
            <InspectorLedgerItem
              label="Company"
              value={item.company ?? "Not reported"}
            />
            <InspectorLedgerItem label="Stage" value={item.stage} />
          </>
        ) : null}
        {item.kind === "source_family" ? (
          <InspectorLedgerItem label="Source family" value={item.sourceFamily} />
        ) : null}
        {item.kind === "orchestration" ? (
          <InspectorLedgerItem label="Operation" value={item.operation} />
        ) : null}
        {item.kind === "unresolved_runtime_activity" ? (
          <>
            <InspectorLedgerItem
              label="Stage"
              value={
                item.stage
                  ? humanStageLabel(snapshot, item.stage)
                  : "Not reported"
              }
            />
            <InspectorLedgerItem
              label="Stage id"
              value={item.stage ?? "Not reported"}
            />
            <InspectorLedgerItem
              label="Opaque activity id"
              value={safeOperationalIdentifier(item.opaqueId)}
            />
          </>
        ) : null}
      </InspectorLedger>
    </li>
  );
}

function PipelineInspector({
  snapshot,
}: {
  readonly snapshot: PipelineOperationsSnapshot;
}) {
  const execution = snapshot.execution;
  const trackingReady = projectionReady(snapshot);
  const coverage = snapshot.projectionCoverage;
  const hasExecutionDetails = execution !== null || coverage !== null;

  return (
    <div className="pipeline-operations-inspector">
      <h2>{hasExecutionDetails ? "Execution inspector" : "Runtime inspector"}</h2>
      {hasExecutionDetails ? (
        <DisclosureSection
          defaultOpen={false}
          description={
            trackingReady
              ? "Selected workflow identity and separately reconciled execution cohorts."
              : "Selected workflow identity and durable history-recovery evidence."
          }
          headingLevel={3}
          title="Technical execution details"
        >
          <InspectorLedger>
            <InspectorLedgerItem
              label="Workflow id"
              value={execution?.discoverWorkflowId}
            />
            <InspectorLedgerItem
              label="Temporal run id"
              value={execution?.discoverRunId}
            />
            <InspectorLedgerItem
              label="Selected as"
              value={execution ? sentenceCase(execution.selectedAs) : "No execution selected"}
            />
            <InspectorLedgerItem
              label="Workflow status"
              value={execution ? sentenceCase(execution.workflowStatus) : "Not available"}
            />
            <InspectorLedgerItem
              label="Phase"
              value={execution ? sentenceCase(execution.phase) : "Idle"}
            />
            <InspectorLedgerItem
              label="Membership closed"
              value={execution ? (execution.membershipClosed ? "Yes" : "No") : "Not available"}
            />
            <InspectorLedgerItem
              label="Started"
              value={execution ? formatDateTime(execution.startedAt) : "Not available"}
            />
            <InspectorLedgerItem
              label="Finished"
              value={execution ? formatDateTime(execution.finishedAt) : "Not available"}
            />
            <InspectorLedgerItem label="Error code" value={execution?.errorCode ?? "None"} />
            <InspectorLedgerItem
              label="Coverage state"
              value={coverage ? sentenceCase(coverage.status) : "Not required"}
            />
            {coverage && coverage.status !== "ready" ? (
              <>
                <InspectorLedgerItem
                  label="Coverage error code"
                  value={
                    coverage.status === "retrying" || coverage.status === "incomplete"
                      ? coverage.errorCode
                      : "None"
                  }
                />
                <InspectorLedgerItem
                  label="History event watermark"
                  value={coverage.historyEventId ?? "Not available"}
                />
                <InspectorLedgerItem
                  label="Recovery decoder"
                  value={coverage.decoderVersion ?? "Not available"}
                />
              </>
            ) : null}
          </InspectorLedger>
          {trackingReady && execution ? (
            <div className="pipeline-cohort-ledgers">
              <CohortLedger
                cohort={execution.currentExecution}
                label="Current execution cohort"
              />
              <CohortLedger
                cohort={execution.sweptExistingBacklog}
                label="Execution sweep cohort"
              />
            </div>
          ) : null}
        </DisclosureSection>
      ) : null}
      <DisclosureSection
        description="Observation freshness, worker slots, internal concurrency, and Temporal queue pressure."
        headingLevel={3}
        title="Freshness and capacity"
      >
        <FreshnessLedger freshness={snapshot.freshness} />
        <CapacityLedger capacity={snapshot.capacity} />
      </DisclosureSection>
      <DisclosureSection
        collapsedSummary={`${snapshot.activeItemsTotal ?? "Unknown"} total${snapshot.activeItemsTruncated ? " · truncated" : ""}`}
        description="Runtime inventory and the provenance available for every active activity."
        headingLevel={3}
        title="Active work"
      >
        <InspectorLedger>
          <InspectorLedgerItem
            label="Inventory total"
            value={snapshot.activeItemsTotal ?? "Unknown"}
          />
          <InspectorLedgerItem
            label="Inventory truncated"
            value={
              snapshot.activeItemsTruncated === null
                ? "Unknown"
                : snapshot.activeItemsTruncated
                  ? "Yes"
                  : "No"
            }
          />
        </InspectorLedger>
        {snapshot.activeItems.length > 0 ? (
          <ol className="pipeline-active-items">
            {snapshot.activeItems.map((item, index) => (
              <ActiveItemLedger
                item={item}
                key={`${item.kind}-${item.activityType}-${item.startedAt}-${index}`}
                snapshot={snapshot}
              />
            ))}
          </ol>
        ) : (
          <Empty title="No active work is visible in the current runtime inventory." />
        )}
      </DisclosureSection>
    </div>
  );
}

function PipelineHeader({
  snapshot,
}: {
  readonly snapshot: PipelineOperationsSnapshot;
}) {
  const execution = snapshot.execution;
  const trackingReady = projectionReady(snapshot);
  const recoveryLabel = recoveryStateLabel(snapshot);
  const sourceLabel = trackingReady
    ? snapshot.sourceFamilies
      ? `${snapshot.sourceFamilies.counts.succeeded}/${snapshot.sourceFamilies.planned}`
      : execution
        ? "Not available"
        : "No selected execution"
    : recoveryLabel;
  const phase = trackingReady
    ? (execution?.phase ?? "idle")
    : (snapshot.projectionCoverage?.status ?? "recovering");

  return (
    <div className="pipeline-operations-header">
      <output className="pipeline-phase-message" aria-live="polite" aria-atomic="true">
        <span>Phase</span>
        <PipelineStatus status={phase}>{sentenceCase(phase)}</PipelineStatus>
      </output>
      <dl className="pipeline-summary-strip" aria-label="Pipeline operations summary">
        <div>
          <dt>Current cohort</dt>
          <dd>
            {!trackingReady
              ? recoveryLabel
              : execution
              ? `${execution.currentExecution.remaining} remaining`
              : "No selected execution"}
          </dd>
        </div>
        <div>
          <dt>Execution sweep</dt>
          <dd>
            {!trackingReady
              ? recoveryLabel
              : execution
              ? `${execution.sweptExistingBacklog.remaining} remaining`
              : "No selected execution"}
          </dd>
        </div>
        <div>
          <dt>Source families</dt>
          <dd>{sourceLabel}</dd>
        </div>
        <div>
          <dt>Overall ETA</dt>
          <dd>
            {trackingReady
              ? etaLabel(snapshot.overallEta)
              : recoveryLabel}
          </dd>
        </div>
        <div>
          <dt>Telemetry</dt>
          <dd>
            <PipelineStatus status={snapshot.freshness.status} />
          </dd>
        </div>
        <div>
          <dt>Snapshot</dt>
          <dd>
            <time dateTime={snapshot.generatedAt}>{formatDateTime(snapshot.generatedAt)}</time>
          </dd>
        </div>
      </dl>
    </div>
  );
}

function PipelineWorkspace({
  snapshot,
}: {
  readonly snapshot: PipelineOperationsSnapshot;
}) {
  const setActiveStage = useStageTriggerStore((state) => state.setActiveStage);
  const trackingReady = projectionReady(snapshot);
  const canStartFromIncompleteHistory =
    snapshot.projectionCoverage?.status === "incomplete" &&
    canSafelyPrepareNewDiscoverRun(snapshot);

  return (
    <RouteWorkspace
      className="pipeline-operations-workspace"
      contentLabel="Live pipeline, backlog diagnostics, and controls"
      header={<PipelineHeader snapshot={snapshot} />}
      inspector={<PipelineInspector snapshot={snapshot} />}
      inspectorLabel={
        trackingReady
          ? "Pipeline execution, capacity, queue, and active-work provenance"
          : "Worker capacity, queue, and active-work provenance"
      }
    >
      <div className="pipeline-operations-workspace__content">
        <PipelineLiveFlow
          onPrepareNewDiscoverRun={() => setActiveStage("discover")}
          snapshot={snapshot}
        />
        {trackingReady ? <PipelineBacklogDiagnostics snapshot={snapshot} /> : null}
        {trackingReady ? <PipelineSources snapshot={snapshot} /> : null}
        {snapshot.projectionCoverage !== null && trackingReady ? (
          <DisclosureSection
            className="pipeline-overall-eta"
            collapsedSummary={etaLabel(snapshot.overallEta)}
            description="Range, confidence, basis, sample size, freshness, and estimator caveats."
            title="Overall completion estimate"
          >
            <div className="pipeline-estimate-summary">
              <PipelineStatus status={snapshot.overallEta.status}>
                {etaLabel(snapshot.overallEta)}
              </PipelineStatus>
              <span>Estimator {snapshot.etaEstimatorVersion}</span>
            </div>
            <EtaLedger eta={snapshot.overallEta} label="Overall ETA facts" />
          </DisclosureSection>
        ) : null}
        {trackingReady || canStartFromIncompleteHistory ? (
          <ToolRow
            aria-label="Pipeline action tools"
            className="pipelines-workspace__controls"
            id="pipeline-actions"
            primary={<StageTriggerPanel />}
            role="group"
          />
        ) : null}
      </div>
    </RouteWorkspace>
  );
}

function EmptyPipelineWorkspace({
  isLoading,
}: {
  readonly isLoading: boolean;
}) {
  return (
    <RouteWorkspace
      className="pipeline-operations-workspace pipeline-operations-workspace--empty"
      contentLabel="Pipeline controls"
      header={
        <div className="pipeline-empty-header">
          <span>Operations</span>
          <strong>{isLoading ? "Loading snapshot" : "Snapshot unavailable"}</strong>
        </div>
      }
    >
      <div className="pipeline-operations-workspace__content">
        <Empty
          title={
            isLoading
              ? "Loading pipeline operations."
              : "No pipeline operations snapshot is available."
          }
        />
        <ToolRow
          aria-label="Pipeline action tools"
          className="pipelines-workspace__controls"
          primary={<StageTriggerPanel />}
          role="group"
        />
      </div>
    </RouteWorkspace>
  );
}

export function PipelinesView() {
  const operations = usePipelineOperationsQuery();
  const errorMessage =
    operations.error instanceof Error ? operations.error.message : null;

  return (
    <div className="pipelines-view route-page route-page--pipelines">
      <PageHead
        eyebrow="Pipeline"
        title="Pipelines"
        subtitle="Follow the current discovery execution, the backlog around it, and the capacity doing the work."
      />
      {errorMessage ? (
        <Alert className="pipeline-operations-alert" variant="destructive">
          <AlertTitle>Pipeline operations unavailable</AlertTitle>
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}
      {operations.data ? (
        <PipelineWorkspace snapshot={operations.data} />
      ) : (
        <EmptyPipelineWorkspace isLoading={operations.isLoading} />
      )}
    </div>
  );
}
