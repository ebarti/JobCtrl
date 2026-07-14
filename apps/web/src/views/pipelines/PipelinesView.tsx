import type {
  PipelineActiveItem,
  PipelineApproximateTaskQueue,
  PipelineCapacity,
  PipelineEta,
  PipelineExecutionCohortSummary,
  PipelineOperationsFreshness,
  PipelineOperationsSnapshot,
  PipelineStageCounts,
  PipelineTaskQueueStats,
} from "@jobctrl/contracts";
import type { ReactNode } from "react";

import { StageTriggerPanel } from "../../contexts/pipeline/components/StageTriggerPanel.js";
import { usePipelineOperationsQuery } from "../../contexts/operations/hooks/usePipelineOperationsQuery.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import { DisclosureSection } from "../../shared/ui/disclosure-section.js";
import { Empty } from "../../shared/ui/empty.js";
import {
  InspectorLedger,
  InspectorLedgerItem,
} from "../../shared/ui/inspector-ledger.js";
import { PageHead } from "../../shared/ui/page-head.js";
import { RouteWorkspace } from "../../shared/ui/route-workspace.js";
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

function sentenceCase(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}

function safeOperationalIdentifier(value: string): string {
  return /(?:https?:\/\/|www\.)/i.test(value) ? "Sensitive identifier withheld" : value;
}

function formatSeconds(value: number): string {
  if (value < 60) return `${Math.round(value)} sec`;
  if (value < 3_600) return `${Math.round(value / 60)} min`;
  return `${(value / 3_600).toFixed(value < 36_000 ? 1 : 0)} hr`;
}

function etaLabel(eta: PipelineEta): string {
  switch (eta.status) {
    case "available":
      return `${formatSeconds(eta.lowSeconds)}–${formatSeconds(eta.highSeconds)}`;
    case "calibrating":
      return `Calibrating · ${eta.completedSamples}/${eta.minimumSamples}`;
    case "paused":
      return `Paused · ${sentenceCase(eta.reason)}`;
    case "stale":
      return `Stale · ${sentenceCase(eta.reason)}`;
    case "unavailable":
      return eta.reason === "no_work" ? "No work remaining" : `Unavailable · ${sentenceCase(eta.reason)}`;
  }
}

function scopeLabel(scope: string): string {
  switch (scope) {
    case "current_execution":
      return "Current execution";
    case "execution_sweep":
      return "Execution sweep";
    case "global_outside_execution":
      return "Global outside execution";
    default:
      return sentenceCase(scope);
  }
}

function CountsFacts({ counts, className = "pipeline-stage-ledger__counts" }: {
  readonly counts: PipelineStageCounts;
  readonly className?: string;
}) {
  return (
    <dl className={className}>
      {COUNT_FIELDS.map(([field, label]) => (
        <div key={field}>
          <dt>{label}</dt>
          <dd>{counts[field]}</dd>
        </div>
      ))}
    </dl>
  );
}

function CohortFacts({ cohort }: { readonly cohort: PipelineExecutionCohortSummary }) {
  return (
    <InspectorLedger>
      {COHORT_FIELDS.map(([field, label]) => (
        <InspectorLedgerItem key={field} label={label} value={cohort[field]} />
      ))}
    </InspectorLedger>
  );
}

function EtaFacts({ eta, label = "ETA" }: { readonly eta: PipelineEta; readonly label?: string }) {
  return (
    <dl className="pipeline-operations-eta" aria-label={label}>
      <div>
        <dt>Status</dt>
        <dd>{sentenceCase(eta.status)}</dd>
      </div>
      {eta.status === "available" ? (
        <>
          <div><dt>Low</dt><dd>{formatSeconds(eta.lowSeconds)}</dd></div>
          <div><dt>High</dt><dd>{formatSeconds(eta.highSeconds)}</dd></div>
          <div><dt>Confidence</dt><dd>{sentenceCase(eta.confidence)}</dd></div>
          <div><dt>Basis</dt><dd>{sentenceCase(eta.basis)}</dd></div>
          <div><dt>Samples</dt><dd>{eta.sampleSize}</dd></div>
          <div><dt>Caveat</dt><dd>{eta.caveat ?? "None"}</dd></div>
        </>
      ) : null}
      {eta.status === "calibrating" ? (
        <>
          <div><dt>Completed samples</dt><dd>{eta.completedSamples}</dd></div>
          <div><dt>Minimum samples</dt><dd>{eta.minimumSamples}</dd></div>
          <div><dt>Reason</dt><dd>{sentenceCase(eta.reason)}</dd></div>
        </>
      ) : null}
      {eta.status === "paused" || eta.status === "stale" || eta.status === "unavailable" ? (
        <div><dt>Reason</dt><dd>{sentenceCase(eta.reason)}</dd></div>
      ) : null}
      <div><dt>As of</dt><dd>{formatDateTime(eta.asOf)}</dd></div>
    </dl>
  );
}

function queueStats(prefix: string, stats: PipelineTaskQueueStats): ReactNode[] {
  return [
    <InspectorLedgerItem key={`${prefix}-pollers`} label={`${prefix} pollers`} value={stats.pollerCount} />,
    <InspectorLedgerItem key={`${prefix}-backlog`} label={`${prefix} backlog`} value={stats.approximateBacklogCount} />,
    <InspectorLedgerItem key={`${prefix}-age`} label={`${prefix} backlog age`} value={formatSeconds(stats.approximateBacklogAgeSeconds)} />,
    <InspectorLedgerItem key={`${prefix}-add`} label={`${prefix} add rate`} value={`${stats.tasksAddRate}/sec`} />,
    <InspectorLedgerItem key={`${prefix}-dispatch`} label={`${prefix} dispatch rate`} value={`${stats.tasksDispatchRate}/sec`} />,
  ];
}

function TaskQueueFacts({ queue }: { readonly queue: PipelineApproximateTaskQueue }) {
  return (
    <InspectorLedger>
      <InspectorLedgerItem label="Observation" value={sentenceCase(queue.status)} />
      <InspectorLedgerItem label="Observed" value={formatDateTime(queue.observedAt)} />
      {queue.status === "available" ? (
        <>
          {queueStats("Workflow", queue.workflow)}
          {queueStats("Activity", queue.activity)}
        </>
      ) : null}
      {queue.status === "stale" ? (
        <InspectorLedgerItem label="Last known status" value={sentenceCase(queue.lastKnownStatus)} />
      ) : null}
      {queue.status === "unsupported" || queue.status === "unavailable" ? (
        <InspectorLedgerItem label="Reason code" value={queue.reasonCode} />
      ) : null}
    </InspectorLedger>
  );
}

function CapacityFacts({ capacity }: { readonly capacity: PipelineCapacity }) {
  return (
    <div className="pipeline-operations-capacity">
      <InspectorLedger>
        <InspectorLedgerItem label="Status" value={sentenceCase(capacity.status)} />
        <InspectorLedgerItem label="Observed" value={formatDateTime(capacity.asOf)} />
        <InspectorLedgerItem label="Stale after" value={`${capacity.staleAfterSeconds} sec`} />
        <InspectorLedgerItem label="Task queue" value={capacity.taskQueue ?? "Not reported"} />
        {capacity.status === "available" ? (
          <>
            <InspectorLedgerItem label="Pool" value={sentenceCase(capacity.kind)} />
            <InspectorLedgerItem label="Fresh workers" value={capacity.freshWorkerCount} />
            <InspectorLedgerItem label="Stale workers" value={capacity.staleWorkerCount} />
            <InspectorLedgerItem label="Invalid workers" value={capacity.invalidWorkerCount} />
            <InspectorLedgerItem label="Configured slots" value={capacity.configuredSlots} />
            <InspectorLedgerItem label="Active slots" value={capacity.activeSlots} />
            <InspectorLedgerItem label="Available slots" value={capacity.availableSlots} />
            <InspectorLedgerItem label="Executor threads" value={capacity.executorThreads} />
            <InspectorLedgerItem
              label="Slot saturation"
              value={capacity.slotSaturation === null ? "Not available" : `${Math.round(capacity.slotSaturation * 100)}%`}
            />
            {capacity.kind === "shared_activity_pool_with_internal_parallelism" ? (
              <InspectorLedgerItem label="Internal concurrency" value={capacity.internalParallelism} />
            ) : null}
          </>
        ) : (
          <InspectorLedgerItem label="Reason" value={capacity.reason} />
        )}
      </InspectorLedger>
      <TaskQueueFacts queue={capacity.approximateTaskQueue} />
    </div>
  );
}

function FreshnessFacts({ freshness }: { readonly freshness: PipelineOperationsFreshness }) {
  return (
    <InspectorLedger>
      <InspectorLedgerItem label="Read-model status" value={sentenceCase(freshness.status)} />
      <InspectorLedgerItem label="As of" value={formatDateTime(freshness.asOf)} />
      <InspectorLedgerItem label="Stale after" value={`${freshness.staleAfterSeconds} sec`} />
      {freshness.status === "fresh" ? null : (
        <InspectorLedgerItem label="Freshness reason" value={freshness.reason} />
      )}
    </InspectorLedger>
  );
}

function ActiveItemFacts({ item }: { readonly item: PipelineActiveItem }) {
  return (
    <li className="pipeline-active-item">
      <InspectorLedger>
        <InspectorLedgerItem label="Kind" value={sentenceCase(item.kind)} />
        <InspectorLedgerItem label="Activity" value={item.activityType} />
        <InspectorLedgerItem label="Workflow" value={item.workflowId ?? "Not reported"} />
        <InspectorLedgerItem label="Execution" value={item.executionId ?? "Not reported"} />
        <InspectorLedgerItem label="Attempt" value={item.attempt} />
        <InspectorLedgerItem label="Started" value={formatDateTime(item.startedAt)} />
        {item.kind === "resolved_job" ? (
          <>
            <InspectorLedgerItem label="Job key" value={safeOperationalIdentifier(item.jobKey)} />
            <InspectorLedgerItem label="Title" value={item.title ?? "Not reported"} />
            <InspectorLedgerItem label="Company" value={item.company ?? "Not reported"} />
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
          <InspectorLedgerItem label="Opaque activity id" value={item.opaqueId} />
        ) : null}
      </InspectorLedger>
    </li>
  );
}

function PipelineStageLedger({ snapshot }: { readonly snapshot: PipelineOperationsSnapshot }) {
  const scopes = ["current_execution", "execution_sweep", "global_outside_execution"] as const;
  return (
    <section className="pipelines-workspace__ledger" aria-labelledby="pipeline-stage-ledger-title">
      <h2 id="pipeline-stage-ledger-title">Operational stage ledger</h2>
      {scopes.map((scope) => {
        const rows = snapshot.stages.filter((stage) => stage.scope === scope);
        if (rows.length === 0) return null;
        return (
          <section
            aria-label={`${scopeLabel(scope)} ledger table`}
            className="pipeline-stage-ledger"
            key={scope}
            tabIndex={0}
          >
            <h3>{scopeLabel(scope)}</h3>
            <table className="pipeline-stage-ledger__table">
              <caption className="visually-hidden">{scopeLabel(scope)} stage state, backlog, capacity, and ETA</caption>
              <thead>
                <tr>
                  <th scope="col">Stage</th>
                  <th scope="col">Scoped outcomes</th>
                  <th scope="col">Existing backlog</th>
                  <th scope="col">Capacity</th>
                  <th scope="col">ETA</th>
                  <th scope="col">Observed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((stage) => (
                  <tr key={`${stage.scope}-${stage.stage}`}>
                    <th scope="row">
                      <strong>{stage.label}</strong>
                      <small>{stage.stage}</small>
                    </th>
                    <td><CountsFacts counts={stage.currentExecution} /></td>
                    <td>
                      {stage.existingBacklog.kind === "domain_jobs" ? (
                        <CountsFacts counts={stage.existingBacklog.counts} className="pipeline-stage-ledger__backlog" />
                      ) : (
                        <span>{sentenceCase(stage.existingBacklog.reason)}</span>
                      )}
                    </td>
                    <td>
                      <strong>{capacityLabel(stage.capacity)}</strong>
                      <details>
                        <summary>Capacity details</summary>
                        <CapacityFacts capacity={stage.capacity} />
                      </details>
                    </td>
                    <td>
                      <strong>{etaLabel(stage.eta)}</strong>
                      <EtaFacts eta={stage.eta} label={`${stage.label} ETA details`} />
                    </td>
                    <td>{formatDateTime(stage.asOf)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
    </section>
  );
}

function capacityLabel(capacity: PipelineCapacity): string {
  if (capacity.status !== "available") return sentenceCase(capacity.status);
  return `${capacity.activeSlots}/${capacity.configuredSlots} active`;
}

function PipelineInspector({ snapshot }: { readonly snapshot: PipelineOperationsSnapshot }) {
  const execution = snapshot.execution;
  return (
    <div className="pipeline-operations-inspector">
      <h2>Execution inspector</h2>
      <DisclosureSection title="Execution and cohorts" defaultOpen>
        <InspectorLedger>
          <InspectorLedgerItem label="Workflow id" value={execution?.discoverWorkflowId} />
          <InspectorLedgerItem label="Temporal run id" value={execution?.discoverRunId} />
          <InspectorLedgerItem label="Selected as" value={execution ? sentenceCase(execution.selectedAs) : "No execution selected"} />
          <InspectorLedgerItem label="Workflow status" value={execution ? sentenceCase(execution.workflowStatus) : "Not available"} />
          <InspectorLedgerItem label="Phase" value={execution ? sentenceCase(execution.phase) : "Idle"} />
          <InspectorLedgerItem label="Membership closed" value={execution ? (execution.membershipClosed ? "Yes" : "No") : "Not available"} />
          <InspectorLedgerItem label="Started" value={execution ? formatDateTime(execution.startedAt) : "Not available"} />
          <InspectorLedgerItem label="Finished" value={execution ? formatDateTime(execution.finishedAt) : "Not available"} />
          <InspectorLedgerItem label="Error code" value={execution?.errorCode ?? "None"} />
        </InspectorLedger>
        {execution ? (
          <>
            <h3>Current execution cohort</h3>
            <CohortFacts cohort={execution.currentExecution} />
            <h3>Execution sweep cohort</h3>
            <CohortFacts cohort={execution.sweptExistingBacklog} />
          </>
        ) : null}
      </DisclosureSection>
      <DisclosureSection title="Freshness and capacity" defaultOpen>
        <FreshnessFacts freshness={snapshot.freshness} />
        <CapacityFacts capacity={snapshot.capacity} />
      </DisclosureSection>
      <DisclosureSection
        title="Active work"
        description={`${snapshot.activeItemsTotal ?? "Unknown"} total${snapshot.activeItemsTruncated ? " · truncated" : ""}`}
        defaultOpen
      >
        <InspectorLedger>
          <InspectorLedgerItem label="Inventory total" value={snapshot.activeItemsTotal ?? "Unknown"} />
          <InspectorLedgerItem
            label="Inventory truncated"
            value={snapshot.activeItemsTruncated === null ? "Unknown" : snapshot.activeItemsTruncated ? "Yes" : "No"}
          />
        </InspectorLedger>
        {snapshot.activeItems.length > 0 ? (
          <ol className="pipeline-active-items">
            {snapshot.activeItems.map((item, index) => (
              <ActiveItemFacts item={item} key={`${item.kind}-${item.activityType}-${item.startedAt}-${index}`} />
            ))}
          </ol>
        ) : (
          <Empty title="No active work is visible in the current runtime inventory." />
        )}
      </DisclosureSection>
    </div>
  );
}

function PipelineSources({ snapshot }: { readonly snapshot: PipelineOperationsSnapshot }) {
  const sourceFamilies = snapshot.sourceFamilies;
  const reconciliation = snapshot.reconciliation;
  return (
    <DisclosureSection
      title="Source families and reconciliation"
      description="Discovery intake and post-source execution are reported independently."
      defaultOpen
    >
      <div className="pipeline-source-reconciliation">
        {sourceFamilies ? (
          <section aria-labelledby="source-family-title">
            <h3 id="source-family-title">Source-family plan</h3>
            <p><strong>{sourceFamilies.counts.succeeded}/{sourceFamilies.planned}</strong> source families succeeded</p>
            <CountsFacts counts={sourceFamilies.counts} />
            <EtaFacts eta={sourceFamilies.eta} label="Source-family ETA details" />
            <p className="muted">Observed {formatDateTime(sourceFamilies.asOf)}</p>
          </section>
        ) : (
          <section aria-labelledby="source-family-title">
            <h3 id="source-family-title">Source-family plan</h3>
            <Empty title="No source-family plan is available for the selected execution." />
          </section>
        )}
        {reconciliation ? (
          <section aria-labelledby="reconciliation-title">
            <h3 id="reconciliation-title">Reconciliation · 2 steps</h3>
            <h4>Enrichment pass</h4>
            <CountsFacts counts={reconciliation.enrichment} />
            <h4>Preparation fanout</h4>
            <CountsFacts counts={reconciliation.preparationFanout} />
            <p className="muted">Observed {formatDateTime(reconciliation.asOf)}</p>
          </section>
        ) : (
          <section aria-labelledby="reconciliation-title">
            <h3 id="reconciliation-title">Reconciliation</h3>
            <Empty title="No reconciliation projection is available for the selected execution." />
          </section>
        )}
      </div>
    </DisclosureSection>
  );
}

function PipelineHeader({ snapshot }: { readonly snapshot: PipelineOperationsSnapshot }) {
  const execution = snapshot.execution;
  const sourceLabel = snapshot.sourceFamilies
    ? `${snapshot.sourceFamilies.counts.succeeded}/${snapshot.sourceFamilies.planned}`
    : "Not available";
  return (
    <div className="pipelines-workspace__live-header" aria-live="polite" aria-atomic="true">
      <div><span>Phase</span><strong>{execution ? sentenceCase(execution.phase) : "Idle"}</strong></div>
      <div><span>Current cohort</span><strong>{execution ? `${execution.currentExecution.remaining} remaining` : "No selected execution"}</strong></div>
      <div><span>Execution sweep</span><strong>{execution ? `${execution.sweptExistingBacklog.remaining} remaining` : "Not available"}</strong></div>
      <div><span>Source families</span><strong>{sourceLabel}</strong></div>
      <div><span>Overall ETA</span><strong>{etaLabel(snapshot.overallEta)}</strong></div>
      <div><span>Snapshot</span><time dateTime={snapshot.generatedAt}>{formatDateTime(snapshot.generatedAt)}</time></div>
    </div>
  );
}

function PipelineWorkspace({ snapshot }: { readonly snapshot: PipelineOperationsSnapshot }) {
  return (
    <RouteWorkspace
      className="pipelines-workspace"
      contentLabel="Pipeline operations ledger and controls"
      inspectorLabel="Pipeline execution, capacity, and active work"
      header={<PipelineHeader snapshot={snapshot} />}
      inspector={<PipelineInspector snapshot={snapshot} />}
    >
      <PipelineStageLedger snapshot={snapshot} />
      <PipelineSources snapshot={snapshot} />
      <DisclosureSection title="Overall completion estimate" defaultOpen>
        <strong>{etaLabel(snapshot.overallEta)}</strong>
        <EtaFacts eta={snapshot.overallEta} label="Overall ETA details" />
        <p className="muted">Estimator {snapshot.etaEstimatorVersion}</p>
      </DisclosureSection>
      <ToolRow className="pipelines-workspace__controls" primary={<StageTriggerPanel />} />
    </RouteWorkspace>
  );
}

export function PipelinesView() {
  const operations = usePipelineOperationsQuery();
  const message = operations.error instanceof Error ? operations.error.message : null;
  return (
    <div className="route-page route-page--pipelines">
      <PageHead eyebrow="Pipeline" title="Pipelines" />
      {message ? <div className="banner" role="alert">Pipeline operations are unavailable: {message}</div> : null}
      {operations.data ? (
        <PipelineWorkspace snapshot={operations.data} />
      ) : (
        <RouteWorkspace
          className="pipelines-workspace"
          contentLabel="Pipeline controls"
          header={
            <div className="pipelines-workspace__live-header">
              <div><span>Operations</span><strong>{operations.isLoading ? "Loading snapshot" : "Snapshot unavailable"}</strong></div>
            </div>
          }
        >
          <Empty title={operations.isLoading ? "Loading pipeline operations." : "No pipeline operations snapshot is available."} />
          <ToolRow className="pipelines-workspace__controls" primary={<StageTriggerPanel />} />
        </RouteWorkspace>
      )}
    </div>
  );
}
