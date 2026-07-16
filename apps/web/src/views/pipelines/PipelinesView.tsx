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
import { Fragment, type ReactNode } from "react";

import { StageTriggerPanel } from "../../contexts/pipeline/components/StageTriggerPanel.js";
import {
  etaLabel,
  formatSeconds,
  safeOperationalIdentifier,
  sentenceCase,
} from "../../contexts/pipeline/components/pipelineOperationsDisplay.js";
import { usePipelineOperationsQuery } from "../../contexts/operations/hooks/usePipelineOperationsQuery.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../shared/ui/alert.js";
import { DisclosureSection } from "../../shared/ui/disclosure-section.js";
import { Empty } from "../../shared/ui/empty.js";
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
      "paused",
      "stale",
      "unsupported",
    ].includes(status)
  ) {
    return "warn";
  }
  if (["discovering", "draining", "in_progress", "processing"].includes(status)) {
    return "info";
  }
  return "muted";
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
    <section className="pipeline-inspector-group" aria-label="Read-model freshness">
      <h3>Freshness</h3>
      <InspectorLedger className="pipeline-compact-ledger">
        <InspectorLedgerItem
          label="Read-model status"
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

function capacityLabel(capacity: PipelineCapacity): string {
  if (capacity.status !== "available") return sentenceCase(capacity.status);
  return `${capacity.activeSlots}/${capacity.configuredSlots} active`;
}

function StageRows({
  stage,
}: {
  readonly stage: PipelineOperationalStage;
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
          <CountSummary counts={stage.currentExecution} />
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
          <strong>{capacityLabel(stage.capacity)}</strong>
          <span>{etaLabel(stage.eta)}</span>
        </TableCell>
        <TableCell className="pipeline-stage-observed">
          <time dateTime={stage.asOf}>{formatDateTime(stage.asOf)}</time>
        </TableCell>
      </TableRow>
      <TableRow className="pipeline-stage-detail-row">
        <TableCell colSpan={6}>
          <DisclosureSection
            className="pipeline-stage-details"
            collapsedSummary={`${etaLabel(stage.eta)} · ${capacityLabel(stage.capacity)}`}
            defaultOpen={false}
            description="Outcomes, backlog, worker and queue capacity, and ETA provenance for this row."
            headingLevel={4}
            title={`Inspect ${stage.label} — ${scope}`}
          >
            <div className="pipeline-stage-details__grid">
              <section className="pipeline-inspector-group">
                <h4>Scoped outcomes</h4>
                <CountLedger
                  counts={stage.currentExecution}
                  label={`${stage.label} scoped outcomes`}
                />
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
              <CapacityLedger capacity={stage.capacity} />
              <section className="pipeline-inspector-group">
                <h4>Completion estimate</h4>
                <EtaLedger eta={stage.eta} label={`${stage.label} ETA facts`} />
              </section>
            </div>
          </DisclosureSection>
        </TableCell>
      </TableRow>
    </Fragment>
  );
}

function PipelineStageLedger({
  snapshot,
}: {
  readonly snapshot: PipelineOperationsSnapshot;
}) {
  const scopes = [
    "current_execution",
    "execution_sweep",
    "global_outside_execution",
  ] as const;

  return (
    <DisclosureSection
      className="pipeline-stage-ledger"
      collapsedSummary={`${snapshot.stages.length} operational rows`}
      description="Current execution and sweep work stay separate from backlog outside this run."
      title="Operational stage ledger"
    >
      {snapshot.stages.length > 0 ? (
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
                    {label} stage state, existing backlog, worker capacity, ETA,
                    and observation time.
                  </TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Stage</TableHead>
                      <TableHead>Scope</TableHead>
                      <TableHead>Current execution</TableHead>
                      <TableHead>Existing backlog</TableHead>
                      <TableHead>Capacity / ETA</TableHead>
                      <TableHead>Observed</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((stage, index) => (
                      <StageRows
                        key={`${stage.scope}-${stage.stage}-${index}`}
                        stage={stage}
                      />
                    ))}
                  </TableBody>
                </Table>
              </section>
            );
          })}
        </div>
      ) : (
        <Empty title="No operational stage rows are available." />
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
        sources
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
            {sources ? (
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
          {sources ? (
            <>
              <Progress value={completion}>
                <ProgressLabel>Source-family progress</ProgressLabel>
                <ProgressValue>{completion}% terminal</ProgressValue>
              </Progress>
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
            {reconciliation ? (
              <PipelineStatus status="in_progress">2 steps</PipelineStatus>
            ) : null}
          </div>
          {reconciliation ? (
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
          ) : (
            <Empty title="No reconciliation projection is available for the selected execution." />
          )}
        </section>
      </div>
    </DisclosureSection>
  );
}

function ActiveItemTitle({ item }: { readonly item: PipelineActiveItem }) {
  switch (item.kind) {
    case "resolved_job":
      return item.title ?? item.company ?? safeOperationalIdentifier(item.jobKey);
    case "source_family":
      return item.sourceFamily;
    case "orchestration":
      return item.operation;
    case "unresolved_runtime_activity":
      return safeOperationalIdentifier(item.opaqueId);
  }
}

function ActiveItemLedger({ item }: { readonly item: PipelineActiveItem }) {
  return (
    <li className="pipeline-active-item">
      <div className="pipeline-active-item__heading">
        <div>
          <h3>
            <ActiveItemTitle item={item} />
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
          <InspectorLedgerItem
            label="Opaque activity id"
            value={safeOperationalIdentifier(item.opaqueId)}
          />
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

  return (
    <div className="pipeline-operations-inspector">
      <h2>Execution inspector</h2>
      <DisclosureSection
        description="Selected workflow identity and separately reconciled execution cohorts."
        headingLevel={3}
        title="Execution and cohorts"
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
        </InspectorLedger>
        {execution ? (
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
  const sourceLabel = snapshot.sourceFamilies
    ? `${snapshot.sourceFamilies.counts.succeeded}/${snapshot.sourceFamilies.planned}`
    : "Not available";
  const phase = execution?.phase ?? "idle";

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
            {execution
              ? `${execution.currentExecution.remaining} remaining`
              : "No selected execution"}
          </dd>
        </div>
        <div>
          <dt>Execution sweep</dt>
          <dd>
            {execution
              ? `${execution.sweptExistingBacklog.remaining} remaining`
              : "Not available"}
          </dd>
        </div>
        <div>
          <dt>Source families</dt>
          <dd>{sourceLabel}</dd>
        </div>
        <div>
          <dt>Overall ETA</dt>
          <dd>{etaLabel(snapshot.overallEta)}</dd>
        </div>
        <div>
          <dt>Read model</dt>
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
  return (
    <RouteWorkspace
      className="pipeline-operations-workspace"
      contentLabel="Pipeline operations ledger and controls"
      header={<PipelineHeader snapshot={snapshot} />}
      inspector={<PipelineInspector snapshot={snapshot} />}
      inspectorLabel="Pipeline execution, capacity, queue, and active-work provenance"
    >
      <div className="pipeline-operations-workspace__content">
        <PipelineStageLedger snapshot={snapshot} />
        <PipelineSources snapshot={snapshot} />
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
