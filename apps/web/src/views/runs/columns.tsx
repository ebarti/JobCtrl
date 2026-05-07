import type { ColumnDef } from "@tanstack/react-table";

import { RunStatusBadge } from "../../contexts/apply/components/RunStatusBadge.js";
import type { WorkflowRunSummary } from "../../contexts/operations/types.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
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
  if (minutes < 60) return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const minRemainder = minutes % 60;
  return minRemainder ? `${hours}h ${minRemainder}m` : `${hours}h`;
}

export const workflowRunColumns: ColumnDef<WorkflowRunSummary>[] = [
  {
    id: "status",
    header: "Status",
    enableSorting: false,
    accessorFn: (row) => row.status,
    cell: ({ row }) => <RunStatusBadge status={row.original.status} />,
  },
  {
    id: "title",
    header: "Job",
    enableSorting: false,
    accessorFn: (row) => row.title,
    cell: ({ row }) => (
      <TitleStack primary={row.original.title} secondary={row.original.company} />
    ),
  },
  {
    id: "workflow",
    header: "Workflow",
    enableSorting: false,
    accessorFn: (row) => row.workflowId,
    cell: ({ row }) => (
      <span className="mono" title={`Workflow id: ${row.original.workflowId}`}>
        {row.original.workflowId}
      </span>
    ),
  },
  {
    id: "model",
    header: "Model",
    enableSorting: false,
    accessorFn: (row) => row.model,
    cell: ({ row }) => <span>{row.original.model ?? "-"}</span>,
  },
  {
    id: "dry_run",
    header: "Mode",
    enableSorting: false,
    accessorFn: (row) => (row.dryRun ? "dry-run" : "live"),
    cell: ({ row }) =>
      row.original.dryRun ? <span className="tag info">dry-run</span> : <span>live</span>,
  },
  {
    id: "started_at",
    header: "Started",
    enableSorting: false,
    accessorFn: (row) => row.startedAt,
    cell: ({ row }) => <RelativeTime value={row.original.startedAt} />,
  },
  {
    id: "duration",
    header: "Duration",
    enableSorting: false,
    accessorFn: (row) => row.durationMs,
    cell: ({ row }) => <span className="mono">{formatDurationMs(row.original.durationMs)}</span>,
  },
  {
    id: "finished_at",
    header: "Finished",
    enableSorting: false,
    accessorFn: (row) => row.finishedAt,
    cell: ({ row }) => (
      <span className="mono" title={formatDateTime(row.original.finishedAt)}>
        {row.original.finishedAt ? formatDateTime(row.original.finishedAt) : "-"}
      </span>
    ),
  },
  {
    id: "temporal_link",
    header: "Temporal Web UI",
    enableSorting: false,
    accessorFn: (row) => row.workflowId,
    cell: ({ row }) => (
      <a
        className="btn ghost"
        href={temporalWebUiWorkflowUrl(row.original.workflowId)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open workflow ${row.original.workflowId} in Temporal Web UI`}
        onClick={(event) => event.stopPropagation()}
      >
        Open in Temporal
      </a>
    ),
  },
];
