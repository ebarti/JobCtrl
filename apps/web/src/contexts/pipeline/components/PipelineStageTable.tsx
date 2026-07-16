import type { PipelineOperationalStage, PipelineOperationsSnapshot } from "@jobctrl/contracts";

import { formatDateTime } from "../../../shared/lib/formatters.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../shared/ui/card.js";
import { Empty } from "../../../shared/ui/empty.js";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../shared/ui/table.js";
import {
  CapacityDetails,
  CountDetails,
  CountSummary,
  EtaDetails,
  FactGrid,
  InlineDisclosure,
  StatusText,
  etaLabel,
  sentenceCase,
} from "./pipelineOperationsDisplay.js";

function scopeLabel(scope: PipelineOperationalStage["scope"]): string {
  switch (scope) {
    case "current_execution":
      return "Current execution";
    case "execution_sweep":
      return "Execution sweep";
    case "global_outside_execution":
      return "Global backlog";
  }
}

function StageRow({ stage }: { readonly stage: PipelineOperationalStage }) {
  return (
    <TableRow>
      <TableCell className="pipeline-stage-name">
        <strong>{stage.label}</strong>
        <code>{stage.stage}</code>
      </TableCell>
      <TableCell>
        <StatusText status={stage.scope === "current_execution" ? "in_progress" : "pending"}>
          {scopeLabel(stage.scope)}
        </StatusText>
      </TableCell>
      <TableCell>
        <CountSummary counts={stage.currentExecution} />
        <InlineDisclosure label="All outcomes">
          <CountDetails counts={stage.currentExecution} label={`${stage.label} current-execution outcomes`} />
        </InlineDisclosure>
      </TableCell>
      <TableCell>
        {stage.existingBacklog.kind === "domain_jobs" ? (
          <>
            <CountSummary counts={stage.existingBacklog.counts} />
            <InlineDisclosure label="All backlog">
              <div className="pipeline-detail-stack">
                <FactGrid facts={[{ label: "Kind", value: "Domain jobs" }]} />
                <CountDetails counts={stage.existingBacklog.counts} label={`${stage.label} existing backlog`} />
              </div>
            </InlineDisclosure>
          </>
        ) : (
          <FactGrid
            facts={[
              { label: "Kind", value: "Not separate" },
              { label: "Reason", value: stage.existingBacklog.reason },
            ]}
          />
        )}
      </TableCell>
      <TableCell className="pipeline-stage-runtime">
        <strong>{stage.capacity.status === "available" ? `${stage.capacity.activeSlots}/${stage.capacity.configuredSlots} active` : sentenceCase(stage.capacity.status)}</strong>
        <span>{etaLabel(stage.eta)}</span>
        <InlineDisclosure label="Runtime diagnostics">
          <div className="pipeline-detail-stack">
            <CapacityDetails capacity={stage.capacity} label={`${stage.label} capacity diagnostics`} />
            <EtaDetails eta={stage.eta} label={`${stage.label} ETA diagnostics`} />
          </div>
        </InlineDisclosure>
      </TableCell>
      <TableCell className="pipeline-stage-observed">
        <time dateTime={stage.asOf}>{formatDateTime(stage.asOf)}</time>
      </TableCell>
    </TableRow>
  );
}

export function PipelineStageTable({ snapshot }: { readonly snapshot: PipelineOperationsSnapshot }) {
  return (
    <Card className="pipeline-card pipeline-stage-table-card">
      <CardHeader className="pipeline-card__header">
        <CardTitle><h2>Operational stage ledger</h2></CardTitle>
        <CardDescription>Current execution and sweep work stay separate from the backlog outside this run.</CardDescription>
      </CardHeader>
      <CardContent className="pipeline-card__content">
        {snapshot.stages.length > 0 ? (
          <Table>
            <TableCaption>Stage state, existing backlog, worker capacity, ETA, and observation time.</TableCaption>
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
              {snapshot.stages.map((stage, index) => (
                <StageRow key={`${stage.scope}-${stage.stage}-${index}`} stage={stage} />
              ))}
            </TableBody>
          </Table>
        ) : (
          <Empty title="No operational stage rows are available." />
        )}
      </CardContent>
    </Card>
  );
}
