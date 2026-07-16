import type { PipelineOperationsSnapshot } from "@jobctrl/contracts";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../shared/ui/card.js";
import { Progress, ProgressLabel, ProgressValue } from "../../../shared/ui/progress.js";
import {
  CapacityDetails,
  FactGrid,
  InlineDisclosure,
  StatusText,
  formatSeconds,
  sentenceCase,
} from "./pipelineOperationsDisplay.js";

export function PipelineCapacityCard({ snapshot }: { readonly snapshot: PipelineOperationsSnapshot }) {
  const capacity = snapshot.capacity;
  const queue = capacity.approximateTaskQueue;
  const saturation = capacity.status === "available" && capacity.slotSaturation !== null
    ? Math.round(capacity.slotSaturation * 100)
    : null;

  return (
    <Card className="pipeline-card pipeline-capacity-card">
      <CardHeader className="pipeline-card__header">
        <CardTitle><h2>Worker capacity</h2></CardTitle>
        <CardDescription>Shared Temporal activity slots and approximate queue pressure.</CardDescription>
      </CardHeader>
      <CardContent className="pipeline-card__content">
        <StatusText status={capacity.status} />
        {capacity.status === "available" ? (
          <>
            <FactGrid
              label="Worker capacity summary"
              facts={[
                { label: "Active slots", value: `${capacity.activeSlots}/${capacity.configuredSlots}` },
                { label: "Available slots", value: capacity.availableSlots },
                { label: "Workers", value: capacity.freshWorkerCount },
                { label: "Task queue", value: capacity.taskQueue ?? "Not reported" },
                { label: "Internal concurrency", value: capacity.kind === "shared_activity_pool_with_internal_parallelism" ? capacity.internalParallelism : "Not reported" },
              ]}
            />
            {saturation !== null ? (
              <Progress value={saturation}>
                <ProgressLabel>Slot saturation</ProgressLabel>
                <ProgressValue>{saturation}%</ProgressValue>
              </Progress>
            ) : null}
          </>
        ) : (
          <p className="pipeline-muted-copy">{capacity.reason}</p>
        )}
        <div className="pipeline-queue-subject">
          <span>Queue observation</span>
          <strong>{sentenceCase(queue.status)}</strong>
          {queue.status === "available" ? (
            <small>
              {queue.activity.approximateBacklogCount} activity tasks · {formatSeconds(queue.activity.approximateBacklogAgeSeconds)} oldest
            </small>
          ) : null}
        </div>
        <InlineDisclosure label="Capacity and queue diagnostics">
          <CapacityDetails capacity={capacity} />
        </InlineDisclosure>
      </CardContent>
    </Card>
  );
}
