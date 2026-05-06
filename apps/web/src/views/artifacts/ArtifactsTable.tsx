import type { RowSelectionState, SortingState } from "@tanstack/react-table";

import type { ArtifactSummary, PaginatedResponse } from "../../contexts/operations/types.js";
import { DataTable } from "../../shared/ui/data-table.js";
import { TablePager } from "../../shared/ui/table-pager.js";
import { artifactColumns } from "./columns.js";

export interface ArtifactsTableProps {
  data: PaginatedResponse<ArtifactSummary> | null;
  loading: boolean;
  sorting: SortingState;
  onSortingChange: (next: SortingState) => void;
  rowSelection: RowSelectionState;
  onRowSelectionChange: (next: RowSelectionState) => void;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onOpenArtifact: (artifactId: string) => void;
}

export function ArtifactsTable({
  data,
  loading,
  sorting,
  onSortingChange,
  rowSelection,
  onRowSelectionChange,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  onOpenArtifact,
}: ArtifactsTableProps) {
  return (
    <DataTable<ArtifactSummary>
      data={data?.items ?? []}
      columns={artifactColumns}
      getRowId={(row) => row.artifactId}
      loading={loading}
      loaded={data !== null}
      loadingMessage="Loading artifacts."
      emptyMessage="No artifacts match."
      headerClassName="data-row artifact artifact-header"
      rowClassName="data-row artifact"
      sorting={sorting}
      onSortingChange={onSortingChange}
      rowSelection={rowSelection}
      onRowSelectionChange={onRowSelectionChange}
      onRowActivate={(row) => onOpenArtifact(row.artifactId)}
      cellClassName={(columnId) => (columnId === "select" ? "row-check" : undefined)}
      footer={
        <TablePager
          page={page}
          pageSize={pageSize}
          totalPages={data?.pagination.pages ?? 1}
          totalRows={data?.pagination.total}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
        />
      }
    />
  );
}
