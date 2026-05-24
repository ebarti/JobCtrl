import { RunStatusBadge } from "../../contexts/apply/components/RunStatusBadge.js";
import type { WorkflowRunSummary } from "../../contexts/operations/types.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import type { DataGridColumn } from "../../shared/ui/filterable-data-grid.js";
import { RelativeTime } from "../../shared/ui/relative-time.js";
import { TitleStack } from "../../shared/ui/title-stack.js";
import { temporalWebUiWorkflowUrl } from "./temporal-web-ui.js";

function formatDurationMs(value: number | null): string {
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

export const workflowRunColumns: Array<DataGridColumn<WorkflowRunSummary>> = [
  {
    id: "status",
    label: "Status",
    sortable: true,
    getFilterValue: (row) => row.status,
    render: (row) => <RunStatusBadge status={row.status} />,
  },
  {
    id: "title",
    label: "Job",
    sortable: true,
    rowHeader: true,
    getFilterValue: (row) => row.title,
    getFilterSearchValue: (row) => `${row.title} ${row.company}`,
    render: (row) => <TitleStack primary={row.title} secondary={row.company} />,
  },
  {
    id: "workflow",
    label: "Workflow",
    getFilterValue: (row) => row.workflowId,
    render: (row) => (
      <span className="mono" title={`Workflow id: ${row.workflowId}`}>
        {row.workflowId}
      </span>
    ),
  },
  {
    id: "model",
    label: "Model",
    sortable: true,
    getFilterValue: (row) => row.model ?? "-",
    render: (row) => <span>{row.model ?? "-"}</span>,
  },
  {
    id: "dry_run",
    label: "Mode",
    sortable: true,
    getFilterValue: (row) => (row.dryRun ? "dry-run" : "live"),
    render: (row) =>
      row.dryRun ? (
        <span className="tag info">dry-run</span>
      ) : (
        <span>live</span>
      ),
  },
  {
    id: "started_at",
    label: "Started",
    sortable: true,
    getFilterValue: (row) => row.startedAt ?? "-",
    render: (row) => <RelativeTime value={row.startedAt} />,
  },
  {
    id: "duration",
    label: "Duration",
    sortable: true,
    getFilterValue: (row) => formatDurationMs(row.durationMs),
    render: (row) => (
      <span className="mono">{formatDurationMs(row.durationMs)}</span>
    ),
  },
  {
    id: "finished_at",
    label: "Finished",
    sortable: true,
    getFilterValue: (row) => row.finishedAt ?? "-",
    render: (row) => (
      <span className="mono" title={formatDateTime(row.finishedAt)}>
        {row.finishedAt ? formatDateTime(row.finishedAt) : "-"}
      </span>
    ),
  },
  {
    id: "temporal_link",
    label: "Temporal Web UI",
    render: (row) => (
      <a
        className="btn ghost"
        href={temporalWebUiWorkflowUrl(row.workflowId)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open workflow ${row.workflowId} in Temporal Web UI`}
        onClick={(event) => event.stopPropagation()}
      >
        Open in Temporal
      </a>
    ),
  },
];
