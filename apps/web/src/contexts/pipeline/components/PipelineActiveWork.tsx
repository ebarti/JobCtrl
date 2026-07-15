import type { PipelineActiveItem, PipelineOperationsSnapshot } from "@jobctrl/contracts";

import { formatDateTime } from "../../../shared/lib/formatters.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../shared/ui/card.js";
import { Empty } from "../../../shared/ui/empty.js";
import {
  FactGrid,
  InlineDisclosure,
  StatusText,
  safeOperationalIdentifier,
  sentenceCase,
} from "./pipelineOperationsDisplay.js";

function itemTitle(item: PipelineActiveItem): string {
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

function ActiveItemDetails({ item }: { readonly item: PipelineActiveItem }) {
  return (
    <li className="pipeline-active-item">
      <div className="pipeline-active-item__heading">
        <div>
          <h3>{itemTitle(item)}</h3>
          <span>{item.activityType}</span>
        </div>
        <StatusText status="in_progress">Attempt {item.attempt}</StatusText>
      </div>
      <FactGrid
        label={`${itemTitle(item)} active-work diagnostics`}
        facts={[
          { label: "Kind", value: sentenceCase(item.kind) },
          { label: "Activity", value: item.activityType },
          { label: "Workflow", value: item.workflowId ?? "Not reported" },
          { label: "Execution", value: item.executionId ?? "Not reported" },
          { label: "Attempt", value: item.attempt },
          { label: "Started", value: formatDateTime(item.startedAt) },
          ...(item.kind === "resolved_job"
            ? [
                { label: "Job key", value: safeOperationalIdentifier(item.jobKey) },
                { label: "Title", value: item.title ?? "Not reported" },
                { label: "Company", value: item.company ?? "Not reported" },
                { label: "Stage", value: item.stage },
              ]
            : []),
          ...(item.kind === "source_family" ? [{ label: "Source family", value: item.sourceFamily }] : []),
          ...(item.kind === "orchestration" ? [{ label: "Operation", value: item.operation }] : []),
          ...(item.kind === "unresolved_runtime_activity"
            ? [{ label: "Opaque id", value: safeOperationalIdentifier(item.opaqueId) }]
            : []),
        ]}
      />
    </li>
  );
}

export function PipelineActiveWork({ snapshot }: { readonly snapshot: PipelineOperationsSnapshot }) {
  const inventoryLabel = snapshot.activeItemsTotal === null ? "Unknown total" : `${snapshot.activeItemsTotal} total`;

  return (
    <Card className="pipeline-card pipeline-active-work">
      <CardHeader className="pipeline-card__header">
        <CardTitle><h2>Active work</h2></CardTitle>
        <CardDescription>Current runtime inventory, including unresolved activities that still consume capacity.</CardDescription>
      </CardHeader>
      <CardContent className="pipeline-card__content">
        <div className="pipeline-active-work__summary">
          <StatusText status={snapshot.activeItems.length > 0 ? "in_progress" : "completed"}>{inventoryLabel}</StatusText>
          <span>
            {snapshot.activeItemsTruncated === null
              ? "Truncation unknown"
              : snapshot.activeItemsTruncated
                ? "Inventory truncated"
                : "Complete inventory"}
          </span>
        </div>
        <InlineDisclosure label="Active work details" defaultOpen={snapshot.activeItems.length > 0}>
          <div className="pipeline-detail-stack">
            <FactGrid
              label="Active-work inventory"
              facts={[
                { label: "Inventory total", value: snapshot.activeItemsTotal ?? "Unknown" },
                { label: "Inventory truncated", value: snapshot.activeItemsTruncated === null ? "Unknown" : snapshot.activeItemsTruncated ? "Yes" : "No" },
              ]}
            />
            {snapshot.activeItems.length > 0 ? (
              <ol className="pipeline-active-items">
                {snapshot.activeItems.map((item, index) => (
                  <ActiveItemDetails item={item} key={`${item.kind}-${item.activityType}-${item.startedAt}-${index}`} />
                ))}
              </ol>
            ) : (
              <Empty title="No active work is visible in the current runtime inventory." />
            )}
          </div>
        </InlineDisclosure>
      </CardContent>
    </Card>
  );
}
