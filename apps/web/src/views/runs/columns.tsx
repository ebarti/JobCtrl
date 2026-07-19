import { RunStatusBadge } from "../../contexts/apply/components/RunStatusBadge.js";
import type { WorkflowRunSummary } from "../../contexts/operations/types.js";
import { CancelWorkflowRunButton } from "../../contexts/pipeline/components/CancelWorkflowRunButton.js";
import type { DataGridColumn } from "../../shared/ui/filterable-data-grid.js";
import { RelativeTime } from "../../shared/ui/relative-time.js";
import { TitleStack } from "../../shared/ui/title-stack.js";
import { temporalWebUiWorkflowUrl } from "./temporal-web-ui.js";

export function formatDurationMs(value: number | null): string {
  if (value === null || value <= 0) return "-";
  if (value < 1_000) return `${value}ms`;
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60)
    return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const minRemainder = minutes % 60;
  return minRemainder ? `${hours}h ${minRemainder}m` : `${hours}h`;
}

function workflowTypeLabel(value: string): string {
  if (!value) return "Workflow";
  const words = value
    .replace(/Workflow$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return words
    ? `${words.charAt(0).toUpperCase()}${words.slice(1)}`
    : "Workflow";
}

const ACTIVE_WORKFLOW_RUN_STATUSES = new Set(["starting", "in_progress"]);

function TemporalRunLink({ row }: { readonly row: WorkflowRunSummary }) {
  return (
    <a
      className="runs-temporal-link"
      data-typography="control"
      href={temporalWebUiWorkflowUrl(row.workflowId)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open workflow ${row.workflowId} in Temporal Web UI`}
      onClick={(event) => event.stopPropagation()}
    >
      Open in Temporal
    </a>
  );
}

function RunActions({ row }: { readonly row: WorkflowRunSummary }) {
  return (
    <div className="runs-row-actions">
      <TemporalRunLink row={row} />
      {ACTIVE_WORKFLOW_RUN_STATUSES.has(row.status) ? (
        <CancelWorkflowRunButton
          runId={row.runId}
          className="btn ghost danger-action"
          label="Stop"
          ariaLabel={`Stop workflow run for ${row.title}`}
        />
      ) : null}
    </div>
  );
}

export function WorkflowRunMobileRow({
  row,
}: {
  readonly row: WorkflowRunSummary;
}) {
  return (
    <div className="run-mobile-row">
      <div className="run-mobile-row__identity">
        <span data-typography="strong-body">
          {row.title || workflowTypeLabel(row.workflowType)}
        </span>
        <RunStatusBadge status={row.status} />
      </div>
      <span className="run-mobile-row__context" data-typography="body">
        {[row.company, workflowTypeLabel(row.workflowType)]
          .filter(Boolean)
          .join(" · ")}
      </span>
      <div className="run-mobile-row__timing" data-typography="metadata">
        <span>
          Started <RelativeTime value={row.startedAt} />
        </span>
        <span>Duration {formatDurationMs(row.durationMs)}</span>
        <span>{row.dryRun ? "Dry run" : "Live"}</span>
      </div>
      <RunActions row={row} />
    </div>
  );
}

export const workflowRunColumns: Array<DataGridColumn<WorkflowRunSummary>> = [
  {
    id: "status",
    label: "Status",
    width: 124,
    minWidth: 112,
    sortable: true,
    getFilterValue: (row) => row.status,
    render: (row) => <RunStatusBadge status={row.status} />,
  },
  {
    id: "title",
    label: "Workflow",
    width: 320,
    minWidth: 240,
    sortable: true,
    rowHeader: true,
    getFilterValue: (row) =>
      `${row.title} ${row.company} ${row.workflowType}`.trim(),
    getFilterSearchValue: (row) =>
      `${row.title} ${row.company} ${row.workflowType} ${row.workflowId}`,
    render: (row) => (
      <TitleStack
        primary={row.title || workflowTypeLabel(row.workflowType)}
        secondary={[row.company, workflowTypeLabel(row.workflowType)]
          .filter(Boolean)
          .join(" · ")}
      />
    ),
  },
  {
    id: "model",
    label: "Execution",
    width: 180,
    minWidth: 148,
    sortable: true,
    getFilterValue: (row) =>
      `${row.model ?? "Default model"} ${row.dryRun ? "dry run" : "live"}`,
    render: (row) => (
      <TitleStack
        primary={row.dryRun ? "Dry run" : "Live"}
        secondary={row.model ?? "Default model"}
      />
    ),
  },
  {
    id: "started_at",
    label: "Started",
    width: 150,
    minWidth: 132,
    sortable: true,
    getFilterValue: (row) => row.startedAt ?? "-",
    render: (row) => <RelativeTime value={row.startedAt} />,
  },
  {
    id: "duration_ms",
    label: "Duration",
    width: 104,
    minWidth: 88,
    sortable: true,
    getFilterValue: (row) => formatDurationMs(row.durationMs),
    render: (row) => <span>{formatDurationMs(row.durationMs)}</span>,
  },
  {
    id: "actions",
    label: "Actions",
    width: 190,
    minWidth: 174,
    render: (row) => <RunActions row={row} />,
  },
];
