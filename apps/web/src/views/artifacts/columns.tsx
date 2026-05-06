import { Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { type ChangeEvent, type MouseEvent } from "react";

import { ArtifactStatusBadge } from "../../contexts/materials/components/ArtifactStatusBadge.js";
import { ArtifactTypeBadge } from "../../contexts/materials/components/ArtifactTypeBadge.js";
import { OpenArtifactButton } from "../../contexts/materials/components/OpenArtifactButton.js";
import { formatBytes } from "../../contexts/materials/lib/artifact-type-format.js";
import type { ArtifactSummary } from "../../contexts/operations/types.js";
import { RelativeTime } from "../../shared/ui/relative-time.js";
import { TitleStack } from "../../shared/ui/title-stack.js";

const selectColumn: ColumnDef<ArtifactSummary> = {
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
      aria-label={`Select ${row.original.title || row.original.type}`}
      checked={row.getIsSelected()}
      disabled={!row.getCanSelect()}
      onChange={(event: ChangeEvent<HTMLInputElement>) =>
        row.toggleSelected(event.target.checked)
      }
      onClick={(event: MouseEvent) => event.stopPropagation()}
    />
  ),
};

export const artifactColumns: ColumnDef<ArtifactSummary>[] = [
  selectColumn,
  {
    id: "title",
    header: "Title",
    enableSorting: true,
    accessorFn: (row) => row.title,
    cell: ({ row }) => (
      <Link
        to="/artifacts/$artifactId"
        params={{ artifactId: row.original.artifactId }}
        className="title-link"
        onClick={(event) => event.stopPropagation()}
      >
        <TitleStack
          primary={row.original.title || row.original.type}
          secondary={row.original.company}
        />
      </Link>
    ),
  },
  {
    id: "company",
    header: "Company",
    enableSorting: true,
    accessorFn: (row) => row.company,
    cell: ({ row }) => <span className="muted-cell">{row.original.company || "-"}</span>,
  },
  {
    id: "type",
    header: "Type",
    enableSorting: true,
    accessorFn: (row) => row.type,
    cell: ({ row }) => <ArtifactTypeBadge artifactType={row.original.type} />,
  },
  {
    id: "status",
    header: "Status",
    enableSorting: true,
    accessorFn: (row) => row.status,
    cell: ({ row }) => <ArtifactStatusBadge status={row.original.status} />,
  },
  {
    id: "size_bytes",
    header: "Size",
    enableSorting: true,
    accessorFn: (row) => row.sizeBytes,
    cell: ({ row }) => (
      <span className="mono">{row.original.size || formatBytes(row.original.sizeBytes)}</span>
    ),
  },
  {
    id: "created_at",
    header: "Created",
    enableSorting: true,
    accessorFn: (row) => row.createdAt,
    cell: ({ row }) => <RelativeTime value={row.original.createdAt} />,
  },
  {
    id: "actions",
    header: "Actions",
    enableSorting: false,
    cell: ({ row }) => (
      <OpenArtifactButton
        artifactId={row.original.artifactId}
        disabled={row.original.status === "missing"}
      />
    ),
  },
];

