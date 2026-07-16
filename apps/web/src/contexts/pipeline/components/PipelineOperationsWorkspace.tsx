import type { PipelineOperationsSnapshot } from "@jobctrl/contracts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../shared/ui/card.js";
import { Empty } from "../../../shared/ui/empty.js";
import { PipelineActiveWork } from "./PipelineActiveWork.js";
import { PipelineCapacityCard } from "./PipelineCapacityCard.js";
import { PipelineOperationsSummary } from "./PipelineOperationsSummary.js";
import { PipelineStageTable } from "./PipelineStageTable.js";
import { SourceCrawlProgress } from "./SourceCrawlProgress.js";
import { StageTriggerPanel } from "./StageTriggerPanel.js";

interface PipelineOperationsWorkspaceProps {
  readonly snapshot: PipelineOperationsSnapshot | undefined;
  readonly isLoading: boolean;
  readonly errorMessage: string | null;
}

export function PipelineOperationsWorkspace({
  snapshot,
  isLoading,
  errorMessage,
}: PipelineOperationsWorkspaceProps) {
  return (
    <div
      className="pipeline-workspace"
      aria-label="Pipeline operations workspace"
    >
      {errorMessage ? (
        <Card className="pipeline-card pipeline-notice-card">
          <CardHeader className="pipeline-card__header">
            <CardTitle>
              <h2>Pipeline operations unavailable</h2>
            </CardTitle>
            <CardDescription>{errorMessage}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}
      {snapshot ? (
        <>
          <PipelineOperationsSummary snapshot={snapshot} />
          <SourceCrawlProgress snapshot={snapshot} />
          <PipelineCapacityCard snapshot={snapshot} />
          <PipelineStageTable snapshot={snapshot} />
          <PipelineActiveWork snapshot={snapshot} />
        </>
      ) : (
        <Card className="pipeline-card pipeline-loading-card">
          <CardHeader className="pipeline-card__header">
            <CardTitle>
              <h2>Operations snapshot</h2>
            </CardTitle>
            <CardDescription>
              Execution, capacity, and backlog facts appear when the read model
              is available.
            </CardDescription>
          </CardHeader>
          <CardContent className="pipeline-card__content">
            <Empty
              title={
                isLoading
                  ? "Loading pipeline operations."
                  : "No pipeline operations snapshot is available."
              }
            />
          </CardContent>
        </Card>
      )}
      <StageTriggerPanel />
    </div>
  );
}
