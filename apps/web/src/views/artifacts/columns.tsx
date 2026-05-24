import { Link } from "@tanstack/react-router";
import type { RowSelectionState } from "@tanstack/react-table";
import { type ChangeEvent, type MouseEvent } from "react";

import { ArtifactStatusBadge } from "../../contexts/materials/components/ArtifactStatusBadge.js";
import { ArtifactTypeBadge } from "../../contexts/materials/components/ArtifactTypeBadge.js";
import { OpenArtifactButton } from "../../contexts/materials/components/OpenArtifactButton.js";
import { formatBytes } from "../../contexts/materials/lib/artifact-type-format.js";
import type { ArtifactSummary } from "../../contexts/operations/types.js";
import type {
  DataGridColumn,
  DataGridHeaderContext,
} from "../../shared/ui/filterable-data-grid.js";
import { RelativeTime } from "../../shared/ui/relative-time.js";
import { TitleStack } from "../../shared/ui/title-stack.js";

interface ArtifactColumnsOptions {
  rowSelection: RowSelectionState;
  onRowSelectionChange: (next: RowSelectionState) => void;
}

function updateSelectedRows(
  rowSelection: RowSelectionState,
  onRowSelectionChange: (next: RowSelectionState) => void,
  rows: readonly ArtifactSummary[],
  checked: boolean,
) {
  const next: RowSelectionState = { ...rowSelection };
  for (const row of rows) {
    if (checked) {
      next[row.artifactId] = true;
    } else {
      delete next[row.artifactId];
    }
  }
  onRowSelectionChange(next);
}

function selectHeader(
  { rowSelection, onRowSelectionChange }: ArtifactColumnsOptions,
  { pageRows }: DataGridHeaderContext<ArtifactSummary>,
) {
  const allSelected =
    pageRows.length > 0 &&
    pageRows.every((row) => Boolean(rowSelection[row.artifactId]));
  const someSelected = pageRows.some((row) =>
    Boolean(rowSelection[row.artifactId]),
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

function updateSelectedRow(
  rowSelection: RowSelectionState,
  onRowSelectionChange: (next: RowSelectionState) => void,
  row: ArtifactSummary,
  checked: boolean,
) {
  updateSelectedRows(rowSelection, onRowSelectionChange, [row], checked);
}

export function artifactColumns(
  options: ArtifactColumnsOptions,
): Array<DataGridColumn<ArtifactSummary>> {
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
          aria-label={`Select ${row.title || row.type}`}
          checked={Boolean(options.rowSelection[row.artifactId])}
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
      id: "title",
      label: "Title",
      sortable: true,
      rowHeader: true,
      getFilterValue: (row) => row.title || row.type,
      render: (row) => (
        <Link
          to="/artifacts/$artifactId"
          params={{ artifactId: row.artifactId }}
          className="title-link"
          onClick={(event) => event.stopPropagation()}
        >
          <TitleStack primary={row.title || row.type} secondary={row.company} />
        </Link>
      ),
    },
    {
      id: "company",
      label: "Company",
      sortable: true,
      getFilterValue: (row) => row.company || "-",
      render: (row) => <span className="muted-cell">{row.company || "-"}</span>,
    },
    {
      id: "type",
      label: "Type",
      sortable: true,
      getFilterValue: (row) => row.type,
      render: (row) => <ArtifactTypeBadge artifactType={row.type} />,
    },
    {
      id: "status",
      label: "Status",
      sortable: true,
      getFilterValue: (row) => row.status,
      render: (row) => <ArtifactStatusBadge status={row.status} />,
    },
    {
      id: "size_bytes",
      label: "Size",
      sortable: true,
      getFilterValue: (row) => row.size || formatBytes(row.sizeBytes),
      render: (row) => (
        <span className="mono">{row.size || formatBytes(row.sizeBytes)}</span>
      ),
    },
    {
      id: "created_at",
      label: "Created",
      sortable: true,
      getFilterValue: (row) => row.createdAt ?? "-",
      render: (row) => <RelativeTime value={row.createdAt} />,
    },
    {
      id: "actions",
      label: "Actions",
      render: (row) => (
        <OpenArtifactButton
          artifactId={row.artifactId}
          disabled={row.status === "missing"}
        />
      ),
    },
  ];
}
