import { usePipelineOperationsQuery } from "../../operations/hooks/usePipelineOperationsQuery.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../shared/ui/card.js";
import { Empty } from "../../../shared/ui/empty.js";
import { PipelineActiveWork } from "./PipelineActiveWork.js";
import { PipelineCapacityCard } from "./PipelineCapacityCard.js";
import { PipelineOperationsSummary } from "./PipelineOperationsSummary.js";
import { PipelineStageTable } from "./PipelineStageTable.js";
import { SourceCrawlProgress } from "./SourceCrawlProgress.js";
import { StageTriggerPanel } from "./StageTriggerPanel.js";

export function PipelineOperationsWorkspace() {
  const operations = usePipelineOperationsQuery();
  const message = operations.error instanceof Error ? operations.error.message : null;

  return (
    <div className="pipeline-workspace" aria-label="Pipeline operations workspace">
      {message ? (
        <Card className="pipeline-card pipeline-notice-card">
          <CardHeader className="pipeline-card__header">
            <CardTitle><h2>Pipeline operations unavailable</h2></CardTitle>
            <CardDescription>{message}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}
      {operations.data ? (
        <>
          <PipelineOperationsSummary snapshot={operations.data} />
          <SourceCrawlProgress snapshot={operations.data} />
          <PipelineCapacityCard snapshot={operations.data} />
          <PipelineStageTable snapshot={operations.data} />
          <PipelineActiveWork snapshot={operations.data} />
        </>
      ) : (
        <Card className="pipeline-card pipeline-loading-card">
          <CardHeader className="pipeline-card__header">
            <CardTitle><h2>Operations snapshot</h2></CardTitle>
            <CardDescription>Execution, capacity, and backlog facts appear when the read model is available.</CardDescription>
          </CardHeader>
          <CardContent className="pipeline-card__content">
            <Empty title={operations.isLoading ? "Loading pipeline operations." : "No pipeline operations snapshot is available."} />
          </CardContent>
        </Card>
      )}
      <StageTriggerPanel />
    </div>
  );
}
