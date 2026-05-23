import type { ColumnDef } from "@tanstack/react-table";
import { type ChangeEvent, type MouseEvent } from "react";

import { ApplyRunBadge } from "../../contexts/apply/components/ApplyRunBadge.js";
import { isApplyRunStatus } from "../../contexts/apply/lib/apply-run-status.js";
import { ScoreBadge } from "../../contexts/scoring/components/ScoreBadge.js";
import { ScoreStalenessBadge } from "../../contexts/scoring/components/ScoreStalenessBadge.js";
import { StageBadge } from "../../contexts/pipeline/components/StageBadge.js";
import type { JobSummary } from "../../contexts/operations/types.js";
import { RelativeTime } from "../../shared/ui/relative-time.js";
import { TitleStack } from "../../shared/ui/title-stack.js";

const selectColumn: ColumnDef<JobSummary> = {
  id: "select",
  enableSorting: false,
  header: ({ table }) => (
    <input
      type="checkbox"
      aria-label="Select all rows on this page"
      checked={table.getIsAllPageRowsSelected()}
      ref={(node) => {
        if (node) {
          node.indeterminate =
            table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected();
        }
      }}
      onChange={(event: ChangeEvent<HTMLInputElement>) =>
        table.toggleAllPageRowsSelected(event.target.checked)
      }
      onClick={(event: MouseEvent) => event.stopPropagation()}
    />
  ),
  cell: ({ row }) => (
    <input
      type="checkbox"
      aria-label={`Select ${row.original.title}`}
      checked={row.getIsSelected()}
      disabled={!row.getCanSelect()}
      onChange={(event: ChangeEvent<HTMLInputElement>) =>
        row.toggleSelected(event.target.checked)
      }
      onClick={(event: MouseEvent) => event.stopPropagation()}
    />
  ),
};

export const jobColumns: ColumnDef<JobSummary>[] = [
  selectColumn,
  {
    id: "fit_score",
    header: "Fit score",
    enableSorting: true,
    accessorFn: (row) => row.fitScore,
    cell: ({ row }) => (
      <div className="score-cell">
        <ScoreBadge score={row.original.fitScore} />
        <ScoreStalenessBadge staleness={row.original.scoreStaleness} />
      </div>
    ),
  },
  {
    id: "title",
    header: "Title",
    enableSorting: true,
    accessorFn: (row) => row.title,
    cell: ({ row }) => <TitleStack primary={row.original.title} />,
  },
  {
    id: "company",
    header: "Company",
    enableSorting: true,
    accessorFn: (row) => row.company,
    cell: ({ row }) => <span className="muted-cell">{row.original.company || "-"}</span>,
  },
  {
    id: "source",
    header: "Sources",
    enableSorting: false,
    accessorFn: (row) => row.postingSource || row.source,
    cell: ({ row }) => (
      <TitleStack
        primary={
          row.original.postingSource
            ? `posting ${row.original.postingSource}`
            : row.original.source
              ? `posting ${row.original.source}`
              : "-"
        }
        secondary={row.original.discoverySource ? `discovered via ${row.original.discoverySource}` : null}
      />
    ),
  },
  {
    id: "location",
    header: "Location",
    enableSorting: true,
    accessorFn: (row) => row.location,
    cell: ({ row }) => <span>{row.original.location || "-"}</span>,
  },
  {
    id: "current_stage",
    header: "Stage",
    enableSorting: true,
    accessorFn: (row) => row.currentStage,
    cell: ({ row }) => <StageBadge stage={row.original.currentStage} />,
  },
  {
    id: "current_state",
    header: "State",
    enableSorting: true,
    accessorFn: (row) => row.currentState,
    cell: ({ row }) => <StageBadge state={row.original.currentState} />,
  },
  {
    id: "discovered_at",
    header: "Discovered",
    enableSorting: true,
    accessorFn: (row) => row.discoveredAt,
    cell: ({ row }) => <RelativeTime value={row.original.discoveredAt} />,
  },
  {
    id: "apply_status",
    header: "Apply",
    enableSorting: false,
    accessorFn: (row) => row.applyStatus,
    cell: ({ row }) => {
      const status = row.original.applyStatus;
      if (!status || !isApplyRunStatus(status)) {
        return null;
      }
      return <ApplyRunBadge result={status} />;
    },
  },
];
