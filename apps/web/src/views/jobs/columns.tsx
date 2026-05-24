import { type ChangeEvent, type MouseEvent } from "react";
import type { RowSelectionState } from "@tanstack/react-table";

import { ApplyRunBadge } from "../../contexts/apply/components/ApplyRunBadge.js";
import { isApplyRunStatus } from "../../contexts/apply/lib/apply-run-status.js";
import { ScoreBadge } from "../../contexts/scoring/components/ScoreBadge.js";
import { ScoreStalenessBadge } from "../../contexts/scoring/components/ScoreStalenessBadge.js";
import { StageBadge } from "../../contexts/pipeline/components/StageBadge.js";
import type { JobSummary } from "../../contexts/operations/types.js";
import type {
  DataGridColumn,
  DataGridHeaderContext,
} from "../../shared/ui/filterable-data-grid.js";
import { RelativeTime } from "../../shared/ui/relative-time.js";
import { TitleStack } from "../../shared/ui/title-stack.js";

interface JobColumnsOptions {
  rowSelection: RowSelectionState;
  onRowSelectionChange: (next: RowSelectionState) => void;
}

function updateSelectedRows(
  rowSelection: RowSelectionState,
  onRowSelectionChange: (next: RowSelectionState) => void,
  rows: readonly JobSummary[],
  checked: boolean,
) {
  const next: RowSelectionState = { ...rowSelection };
  for (const row of rows) {
    if (checked) {
      next[row.jobKey] = true;
    } else {
      delete next[row.jobKey];
    }
  }
  onRowSelectionChange(next);
}

function updateSelectedRow(
  rowSelection: RowSelectionState,
  onRowSelectionChange: (next: RowSelectionState) => void,
  row: JobSummary,
  checked: boolean,
) {
  updateSelectedRows(rowSelection, onRowSelectionChange, [row], checked);
}

function selectHeader(
  { rowSelection, onRowSelectionChange }: JobColumnsOptions,
  { pageRows }: DataGridHeaderContext<JobSummary>,
) {
  const allSelected =
    pageRows.length > 0 &&
    pageRows.every((row) => Boolean(rowSelection[row.jobKey]));
  const someSelected = pageRows.some((row) =>
    Boolean(rowSelection[row.jobKey]),
  );
  return (
    <input
      type="checkbox"
      aria-label="Select all rows on this page"
      checked={allSelected}
      ref={(node) => {
        if (node) {
          node.indeterminate = someSelected && !allSelected;
        }
      }}
      onChange={(event: ChangeEvent<HTMLInputElement>) =>
        updateSelectedRows(
          rowSelection,
          onRowSelectionChange,
          pageRows,
          event.target.checked,
        )
      }
      onClick={(event: MouseEvent) => event.stopPropagation()}
    />
  );
}

export function jobColumns(
  options: JobColumnsOptions,
): Array<DataGridColumn<JobSummary>> {
  return [
    {
      id: "select",
      label: "Select",
      header: (context) => selectHeader(options, context),
      className: "row-check",
      headerClassName: "row-check",
      render: (row) => (
        <input
          type="checkbox"
          aria-label={`Select ${row.title}`}
          checked={Boolean(options.rowSelection[row.jobKey])}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            updateSelectedRow(
              options.rowSelection,
              options.onRowSelectionChange,
              row,
              event.target.checked,
            )
          }
          onClick={(event: MouseEvent) => event.stopPropagation()}
        />
      ),
    },
    {
      id: "fit_score",
      label: "Fit score",
      sortable: true,
      getFilterValue: (row) => String(row.fitScore ?? "unscored"),
      render: (row) => (
        <div className="score-cell">
          <ScoreBadge score={row.fitScore} />
          <ScoreStalenessBadge staleness={row.scoreStaleness} />
        </div>
      ),
    },
    {
      id: "title",
      label: "Title",
      sortable: true,
      rowHeader: true,
      getFilterValue: (row) => row.title,
      render: (row) => <TitleStack primary={row.title} />,
    },
    {
      id: "company",
      label: "Company",
      sortable: true,
      getFilterValue: (row) => row.company || "-",
      render: (row) => <span className="muted-cell">{row.company || "-"}</span>,
    },
    {
      id: "source",
      label: "Sources",
      getFilterValue: (row) =>
        row.postingSource || row.discoverySource || row.source || "-",
      getFilterSearchValue: (row) =>
        [row.postingSource, row.discoverySource, row.source]
          .filter(Boolean)
          .join(" "),
      render: (row) => (
        <TitleStack
          primary={row.postingSource ? `posting ${row.postingSource}` : "-"}
          secondary={
            row.discoverySource ? `discovered via ${row.discoverySource}` : null
          }
        />
      ),
    },
    {
      id: "location",
      label: "Location",
      sortable: true,
      getFilterValue: (row) => row.location || "-",
      render: (row) => <span>{row.location || "-"}</span>,
    },
    {
      id: "current_stage",
      label: "Stage",
      sortable: true,
      getFilterValue: (row) => row.currentStage,
      render: (row) => <StageBadge stage={row.currentStage} />,
    },
    {
      id: "current_state",
      label: "State",
      sortable: true,
      getFilterValue: (row) => row.currentState,
      render: (row) => <StageBadge state={row.currentState} />,
    },
    {
      id: "discovered_at",
      label: "Discovered",
      sortable: true,
      getFilterValue: (row) => row.discoveredAt || "-",
      render: (row) => <RelativeTime value={row.discoveredAt} />,
    },
    {
      id: "apply_status",
      label: "Apply",
      getFilterValue: (row) => row.applyStatus ?? "not applied",
      render: (row) => {
        const status = row.applyStatus;
        if (!status || !isApplyRunStatus(status)) {
          return null;
        }
        return <ApplyRunBadge result={status} />;
      },
    },
  ];
}
