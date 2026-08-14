import type {
  PipelineApproximateTaskQueue,
  PipelineCapacity,
  PipelineEta,
  PipelineExecutionCohortSummary,
  PipelineOperationsFreshness,
  PipelineStageCounts,
  PipelineTaskQueueStats,
} from "@jobctrl/contracts";
import { IconChevronDown } from "@tabler/icons-react";
import type { ReactNode } from "react";

import { formatDateTime } from "../../../shared/lib/formatters.js";
import { Badge } from "../../../shared/ui/badge.js";
import { Button } from "../../../shared/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../../shared/ui/collapsible.js";
import { StatusDot } from "../../../shared/ui/status-dot.js";
import type { StatusDotState } from "../../../shared/ui/status-tokens.js";

export const COUNT_FIELDS = [
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

export const COHORT_FIELDS = [
  ["members", "Members"],
  ["planned", "Planned"],
  ["notEligible", "Not eligible"],
  ["pending", "Pending plan"],
  ["failedPlan", "Failed plan"],
  ["terminal", "Terminal"],
  ["remaining", "Remaining"],
] as const;

export function sentenceCase(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}

export function safeOperationalIdentifier(value: string): string {
  return /(?:https?:\/\/|www\.)/i.test(value) ? "Sensitive identifier withheld" : value;
}

export function formatSeconds(value: number): string {
  if (value < 60) return `${Math.round(value)} sec`;
  if (value < 3_600) return `${Math.round(value / 60)} min`;
  return `${(value / 3_600).toFixed(value < 36_000 ? 1 : 0)} hr`;
}

function pausedEtaReasonLabel(
  reason: Extract<PipelineEta, { status: "paused" }>["reason"],
): string {
  switch (reason) {
    case "no_dispatch":
      return "No recent dispatch activity";
    case "budget_exceeded":
      return "Budget limit reached";
    case "blocked":
      return "Work is blocked";
    case "worker_unavailable":
      return "Worker unavailable";
  }
}

export function etaStatusLabel(eta: PipelineEta): string {
  return eta.status === "paused" ? "No ETA" : sentenceCase(eta.status);
}

export function etaReasonLabel(
  eta: Extract<PipelineEta, { status: "paused" | "stale" | "unavailable" }>,
): string {
  return eta.status === "paused"
    ? pausedEtaReasonLabel(eta.reason)
    : sentenceCase(eta.reason);
}

export function etaLabel(eta: PipelineEta): string {
  switch (eta.status) {
    case "available":
      return `${formatSeconds(eta.lowSeconds)}–${formatSeconds(eta.highSeconds)}`;
    case "calibrating":
      return `Calibrating · ${eta.completedSamples}/${eta.minimumSamples}`;
    case "paused":
      return `No ETA · ${pausedEtaReasonLabel(eta.reason)}`;
    case "stale":
      return `Stale · ${sentenceCase(eta.reason)}`;
    case "unavailable":
      return eta.reason === "no_work" ? "No work remaining" : `Unavailable · ${sentenceCase(eta.reason)}`;
  }
}

export function statusDotState(status: string): StatusDotState {
  if (["completed", "succeeded", "fresh", "available"].includes(status)) return "succeeded";
  if (["failed", "unavailable"].includes(status)) return "failed";
  if (["completed_with_issues", "blocked", "paused", "unsupported"].includes(status)) return "blocked";
  if (["discovering", "draining", "processing", "in_progress"].includes(status)) return "running";
  if (["stale", "calibrating"].includes(status)) return "stale";
  if (status === "canceled") return "canceled";
  return "pending";
}

export function StatusText({ status, children }: { readonly status: string; readonly children?: ReactNode }) {
  return (
    <Badge className="pipeline-status" variant="outline">
      <StatusDot state={statusDotState(status)} />
      <span>{children ?? sentenceCase(status)}</span>
    </Badge>
  );
}

interface Fact {
  readonly label: string;
  readonly value: ReactNode;
}

export function FactGrid({ facts, label }: { readonly facts: readonly Fact[]; readonly label?: string }) {
  return (
    <dl className="pipeline-facts" aria-label={label}>
      {facts.map((fact) => (
        <div key={fact.label}>
          <dt>{fact.label}</dt>
          <dd>{fact.value ?? "-"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function InlineDisclosure({
  label,
  children,
  defaultOpen = false,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly defaultOpen?: boolean;
}) {
  return (
    <Collapsible className="pipeline-disclosure" defaultOpen={defaultOpen}>
      <CollapsibleTrigger
        render={<Button className="pipeline-disclosure__trigger" size="sm" type="button" variant="ghost" />}
      >
        <IconChevronDown aria-hidden="true" data-icon="inline-start" />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent className="pipeline-disclosure__content">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function CountDetails({ counts, label }: { readonly counts: PipelineStageCounts; readonly label: string }) {
  return (
    <FactGrid
      label={label}
      facts={COUNT_FIELDS.map(([field, fieldLabel]) => ({ label: fieldLabel, value: counts[field] }))}
    />
  );
}

export function CountSummary({ counts }: { readonly counts: PipelineStageCounts }) {
  const active = counts.waiting + counts.processing;
  const issues = counts.blocked + counts.failed + counts.exhausted + counts.needsVerification + counts.stale + counts.unknown;
  return (
    <span className="pipeline-count-summary">
      <span><b>{active}</b> active</span>
      <span><b>{counts.succeeded}</b> done</span>
      {issues > 0 ? <span><b>{issues}</b> attention</span> : null}
    </span>
  );
}

export function CohortDetails({ cohort, label }: { readonly cohort: PipelineExecutionCohortSummary; readonly label: string }) {
  return (
    <FactGrid
      label={label}
      facts={COHORT_FIELDS.map(([field, fieldLabel]) => ({ label: fieldLabel, value: cohort[field] }))}
    />
  );
}

export function EtaDetails({ eta, label }: { readonly eta: PipelineEta; readonly label: string }) {
  const facts: Fact[] = [
    { label: "Status", value: etaStatusLabel(eta) },
    ...(eta.status === "available"
      ? [
          { label: "Low", value: formatSeconds(eta.lowSeconds) },
          { label: "High", value: formatSeconds(eta.highSeconds) },
          { label: "Confidence", value: sentenceCase(eta.confidence) },
          { label: "Basis", value: sentenceCase(eta.basis) },
          { label: "Samples", value: eta.sampleSize },
          { label: "Caveat", value: eta.caveat ?? "None" },
        ]
      : []),
    ...(eta.status === "calibrating"
      ? [
          { label: "Completed samples", value: eta.completedSamples },
          { label: "Minimum samples", value: eta.minimumSamples },
          { label: "Reason", value: sentenceCase(eta.reason) },
        ]
      : []),
    ...(eta.status === "paused" || eta.status === "stale" || eta.status === "unavailable"
      ? [{ label: "Reason", value: etaReasonLabel(eta) }]
      : []),
    { label: "As of", value: formatDateTime(eta.asOf) },
  ];
  return <FactGrid facts={facts} label={label} />;
}

function queueStats(prefix: string, stats: PipelineTaskQueueStats): Fact[] {
  return [
    { label: `${prefix} pollers`, value: stats.pollerCount },
    { label: `${prefix} backlog`, value: stats.approximateBacklogCount },
    { label: `${prefix} backlog age`, value: formatSeconds(stats.approximateBacklogAgeSeconds) },
    { label: `${prefix} add rate`, value: `${stats.tasksAddRate}/sec` },
    { label: `${prefix} dispatch rate`, value: `${stats.tasksDispatchRate}/sec` },
  ];
}

export function TaskQueueDetails({ queue, label = "Task queue diagnostics" }: {
  readonly queue: PipelineApproximateTaskQueue;
  readonly label?: string;
}) {
  const facts: Fact[] = [
    { label: "Observation", value: sentenceCase(queue.status) },
    { label: "Observed", value: formatDateTime(queue.observedAt) },
    ...(queue.status === "available" ? [...queueStats("Workflow", queue.workflow), ...queueStats("Activity", queue.activity)] : []),
    ...(queue.status === "stale" ? [{ label: "Last known status", value: sentenceCase(queue.lastKnownStatus) }] : []),
    ...(queue.status === "unsupported" || queue.status === "unavailable"
      ? [{ label: "Reason code", value: queue.reasonCode }]
      : []),
  ];
  return <FactGrid facts={facts} label={label} />;
}

export function CapacityDetails({ capacity, label = "Capacity diagnostics" }: {
  readonly capacity: PipelineCapacity;
  readonly label?: string;
}) {
  const facts: Fact[] = [
    { label: "Status", value: sentenceCase(capacity.status) },
    { label: "Observed", value: formatDateTime(capacity.asOf) },
    { label: "Stale after", value: `${capacity.staleAfterSeconds} sec` },
    { label: "Task queue", value: capacity.taskQueue ?? "Not reported" },
    ...(capacity.status === "available"
      ? [
          { label: "Pool", value: sentenceCase(capacity.kind) },
          { label: "Fresh workers", value: capacity.freshWorkerCount },
          { label: "Stale workers", value: capacity.staleWorkerCount },
          { label: "Invalid workers", value: capacity.invalidWorkerCount },
          { label: "Configured slots", value: capacity.configuredSlots },
          { label: "Active slots", value: capacity.activeSlots },
          { label: "Available slots", value: capacity.availableSlots },
          { label: "Executor threads", value: capacity.executorThreads },
          { label: "Slot saturation", value: capacity.slotSaturation === null ? "Not available" : `${Math.round(capacity.slotSaturation * 100)}%` },
          ...(capacity.kind === "shared_activity_pool_with_internal_parallelism"
            ? [{ label: "Internal concurrency", value: capacity.internalParallelism }]
            : []),
        ]
      : [{ label: "Reason", value: capacity.reason }]),
  ];
  return (
    <div className="pipeline-detail-stack">
      <FactGrid facts={facts} label={label} />
      <TaskQueueDetails queue={capacity.approximateTaskQueue} />
    </div>
  );
}

export function FreshnessDetails({ freshness }: { readonly freshness: PipelineOperationsFreshness }) {
  return (
    <FactGrid
      label="Read-model freshness"
      facts={[
        { label: "Read-model status", value: sentenceCase(freshness.status) },
        { label: "As of", value: formatDateTime(freshness.asOf) },
        { label: "Stale after", value: `${freshness.staleAfterSeconds} sec` },
        ...(freshness.status === "fresh" ? [] : [{ label: "Freshness reason", value: freshness.reason }]),
      ]}
    />
  );
}
