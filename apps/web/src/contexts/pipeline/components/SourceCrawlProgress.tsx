import type { PipelineOperationsSnapshot, PipelineStageCounts } from "@jobctrl/contracts";

import { formatDateTime } from "../../../shared/lib/formatters.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../shared/ui/card.js";
import { Empty } from "../../../shared/ui/empty.js";
import { Progress, ProgressLabel, ProgressValue } from "../../../shared/ui/progress.js";
import { Separator } from "../../../shared/ui/separator.js";
import {
  CountDetails,
  CountSummary,
  EtaDetails,
  InlineDisclosure,
  StatusText,
} from "./pipelineOperationsDisplay.js";

function completedCount(counts: PipelineStageCounts): number {
  return counts.succeeded
    + counts.skipped
    + counts.blocked
    + counts.failed
    + counts.exhausted
    + counts.canceled
    + counts.needsVerification;
}

export function SourceCrawlProgress({ snapshot }: { readonly snapshot: PipelineOperationsSnapshot }) {
  const sources = snapshot.sourceFamilies;
  const reconciliation = snapshot.reconciliation;
  const completion = sources && sources.planned > 0
    ? Math.min(100, Math.round((completedCount(sources.counts) / sources.planned) * 100))
    : 0;

  return (
    <Card className="pipeline-card pipeline-source-progress">
      <CardHeader className="pipeline-card__header">
        <CardTitle><h2>Source crawl progress</h2></CardTitle>
        <CardDescription>
          Parallel source work and enrichment site batches inside a running activity. Temporal worker capacity is shown below.
        </CardDescription>
      </CardHeader>
      <CardContent className="pipeline-card__content">
        {sources ? (
          <>
            <div className="pipeline-source-progress__heading">
              <StatusText status={sources.counts.processing > 0 ? "processing" : completion === 100 ? "completed" : "pending"}>
                {sources.counts.succeeded}/{sources.planned} succeeded
              </StatusText>
              <time dateTime={sources.asOf}>{formatDateTime(sources.asOf)}</time>
            </div>
            <Progress value={completion}>
              <ProgressLabel>Source-family plan</ProgressLabel>
              <ProgressValue>{completion}% terminal</ProgressValue>
            </Progress>
            <CountSummary counts={sources.counts} />
            <InlineDisclosure label="Source-family diagnostics">
              <div className="pipeline-detail-stack">
                <CountDetails counts={sources.counts} label="Source-family outcomes" />
                <EtaDetails eta={sources.eta} label="Source-family ETA diagnostics" />
              </div>
            </InlineDisclosure>
          </>
        ) : (
          <Empty title="No source-family plan is available for the selected execution." />
        )}
        <Separator />
        <div className="pipeline-reconciliation">
          <div className="pipeline-section-heading">
            <div>
              <h3>Enrichment reconciliation</h3>
              <p>Runs one final enrichment pass for stragglers, then hands every ready job to preparation.</p>
            </div>
            {reconciliation ? <time dateTime={reconciliation.asOf}>{formatDateTime(reconciliation.asOf)}</time> : null}
          </div>
          {reconciliation ? (
            <>
              <div className="pipeline-reconciliation__rows">
                <div>
                  <strong>Enrichment pass</strong>
                  <CountSummary counts={reconciliation.enrichment} />
                </div>
                <div>
                  <strong>Preparation fanout</strong>
                  <CountSummary counts={reconciliation.preparationFanout} />
                </div>
              </div>
              <InlineDisclosure label="Enrichment reconciliation diagnostics">
                <div className="pipeline-detail-stack">
                  <CountDetails counts={reconciliation.enrichment} label="Enrichment pass outcomes" />
                  <CountDetails counts={reconciliation.preparationFanout} label="Preparation fanout outcomes" />
                </div>
              </InlineDisclosure>
            </>
          ) : (
            <Empty title="No enrichment reconciliation history is available for the selected execution." />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
