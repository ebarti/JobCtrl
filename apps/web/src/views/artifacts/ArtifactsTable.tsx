import type { RowSelectionState, SortingState } from "@tanstack/react-table";
import { useMemo } from "react";

import type {
  ArtifactSummary,
  PaginatedResponse,
} from "../../contexts/operations/types.js";
import { useIsMobile } from "../../shared/hooks/use-mobile.js";
import {
  FilterableDataGrid,
  type DataGridSortState,
} from "../../shared/ui/filterable-data-grid.js";
import { ArtifactMobileRow, artifactColumns } from "./columns.js";

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
  const isMobile = useIsMobile();
  const columnOptions = useMemo(
    () => ({ rowSelection, onRowSelectionChange }),
    [onRowSelectionChange, rowSelection],
  );
  const columns = useMemo(
    () => artifactColumns(columnOptions),
    [columnOptions],
  );
  const gridSort = useMemo<DataGridSortState>(() => {
    const head = sorting[0];
    return {
      columnId: head?.id ?? "created_at",
      direction: head?.desc ? "desc" : "asc",
    };
  }, [sorting]);
  const handleSortChange = (next: DataGridSortState) => {
    onSortingChange([{ id: next.columnId, desc: next.direction === "desc" }]);
  };

  return (
    <FilterableDataGrid<ArtifactSummary>
      title="Artifacts table"
      data={data?.items ?? []}
      columns={columns}
      getRowId={(row) => row.artifactId}
      loading={loading}
      loadingMessage="Loading artifacts."
      emptyMessage="No artifacts match."
      initialSort={{ columnId: "created_at", direction: "desc" }}
      mobileLayout="cards"
      {...(isMobile
        ? {
            mobileListLabel: "Artifacts",
            renderMobileRow: (row) => (
              <ArtifactMobileRow options={columnOptions} row={row} />
            ),
          }
        : {})}
      sort={gridSort}
      onSortChange={handleSortChange}
      manualSorting
      tableClassName="artifacts-data-grid-table"
      rowAriaSelected={(row) => Boolean(rowSelection[row.artifactId])}
      onRowActivate={(row) => onOpenArtifact(row.artifactId)}
      rowActivationAppearance={isMobile ? "visible" : "focus-only"}
      rowActivationLabel={(row) => `Open artifact ${row.title || row.type}`}
      pagination={{
        page,
        pageSize,
        totalPages: data?.pagination.pages ?? 1,
        ...(typeof data?.pagination.total === "number"
          ? { totalRows: data.pagination.total }
          : {}),
        onPageChange,
        onPageSizeChange,
      }}
    />
  );
}
