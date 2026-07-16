import type { PipelineOperationsSnapshot } from "@jobctrl/contracts";

import { formatDateTime } from "../../../shared/lib/formatters.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../shared/ui/card.js";
import { Separator } from "../../../shared/ui/separator.js";
import {
  CohortDetails,
  EtaDetails,
  FactGrid,
  FreshnessDetails,
  InlineDisclosure,
  StatusText,
  etaLabel,
  sentenceCase,
} from "./pipelineOperationsDisplay.js";

export function PipelineOperationsSummary({ snapshot }: { readonly snapshot: PipelineOperationsSnapshot }) {
  const execution = snapshot.execution;
  const phase = execution?.phase ?? "idle";
  const sourceProgress = snapshot.sourceFamilies
    ? `${snapshot.sourceFamilies.counts.succeeded}/${snapshot.sourceFamilies.planned}`
    : "Not available";

  return (
    <Card className="pipeline-card pipeline-operations-summary">
      <CardHeader className="pipeline-card__header">
        <CardTitle><h2>Pipeline operations</h2></CardTitle>
        <CardDescription>Execution scope, backlog, and the latest completion estimate.</CardDescription>
      </CardHeader>
      <CardContent className="pipeline-card__content">
        <output className="pipeline-phase-message" aria-live="polite" aria-atomic="true">
          <span>Phase</span>
          <StatusText status={phase}>{sentenceCase(phase)}</StatusText>
        </output>
        <dl className="pipeline-summary-strip" aria-label="Pipeline operations summary">
          <div>
            <dt>Current cohort</dt>
            <dd>{execution ? `${execution.currentExecution.remaining} remaining` : "No selected execution"}</dd>
          </div>
          <div>
            <dt>Execution sweep</dt>
            <dd>{execution ? `${execution.sweptExistingBacklog.remaining} remaining` : "Not available"}</dd>
          </div>
          <div>
            <dt>Source families</dt>
            <dd>{sourceProgress}</dd>
          </div>
          <div>
            <dt>Overall ETA</dt>
            <dd>{etaLabel(snapshot.overallEta)}</dd>
          </div>
          <div>
            <dt>Snapshot</dt>
            <dd><time dateTime={snapshot.generatedAt}>{formatDateTime(snapshot.generatedAt)}</time></dd>
          </div>
          <div>
            <dt>Read model</dt>
            <dd><StatusText status={snapshot.freshness.status} /></dd>
          </div>
        </dl>
        <Separator />
        <InlineDisclosure label="Execution diagnostics">
          <div className="pipeline-detail-stack">
            <FactGrid
              label="Execution identity"
              facts={[
                { label: "Workflow id", value: execution?.discoverWorkflowId ?? "Not available" },
                { label: "Temporal run id", value: execution?.discoverRunId ?? "Not available" },
                { label: "Selected as", value: execution ? sentenceCase(execution.selectedAs) : "No execution selected" },
                { label: "Workflow status", value: execution ? sentenceCase(execution.workflowStatus) : "Not available" },
                { label: "Phase", value: execution ? sentenceCase(execution.phase) : "Idle" },
                { label: "Membership closed", value: execution ? (execution.membershipClosed ? "Yes" : "No") : "Not available" },
                { label: "Started", value: execution ? formatDateTime(execution.startedAt) : "Not available" },
                { label: "Finished", value: execution ? formatDateTime(execution.finishedAt) : "Not available" },
                { label: "Error code", value: execution?.errorCode ?? "None" },
                { label: "ETA estimator", value: snapshot.etaEstimatorVersion },
              ]}
            />
            {execution ? (
              <>
                <CohortDetails cohort={execution.currentExecution} label="Current execution cohort" />
                <CohortDetails cohort={execution.sweptExistingBacklog} label="Execution sweep cohort" />
              </>
            ) : null}
            <EtaDetails eta={snapshot.overallEta} label="Overall ETA diagnostics" />
            <FreshnessDetails freshness={snapshot.freshness} />
          </div>
        </InlineDisclosure>
      </CardContent>
    </Card>
  );
}
