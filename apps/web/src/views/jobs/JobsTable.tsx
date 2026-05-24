import type { RowSelectionState, SortingState } from "@tanstack/react-table";
import { useMemo } from "react";

import type {
  JobSummary,
  PaginatedResponse,
} from "../../contexts/operations/types.js";
import {
  FilterableDataGrid,
  type DataGridSortState,
} from "../../shared/ui/filterable-data-grid.js";
import { jobColumns } from "./columns.js";

export interface JobsTableProps {
  data: PaginatedResponse<JobSummary> | null;
  loading: boolean;
  sorting: SortingState;
  onSortingChange: (next: SortingState) => void;
  rowSelection: RowSelectionState;
  onRowSelectionChange: (next: RowSelectionState) => void;
  allMatchingSelected: boolean;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onOpenJob: (jobKey: string) => void;
}

export function JobsTable({
  data,
  loading,
  sorting,
  onSortingChange,
  rowSelection,
  onRowSelectionChange,
  allMatchingSelected,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  onOpenJob,
}: JobsTableProps) {
  const displayedRowSelection = useMemo<RowSelectionState>(() => {
    if (!allMatchingSelected) {
      return rowSelection;
    }
    const next: RowSelectionState = {};
    for (const job of data?.items ?? []) {
      next[job.jobKey] = true;
    }
    return next;
  }, [allMatchingSelected, data?.items, rowSelection]);
  const columns = useMemo(
    () =>
      jobColumns({
        rowSelection: displayedRowSelection,
        onRowSelectionChange,
      }),
    [displayedRowSelection, onRowSelectionChange],
  );
  const gridSort = useMemo<DataGridSortState>(() => {
    const head = sorting[0];
    return {
      columnId: head?.id ?? "discovered_at",
      direction: head?.desc ? "desc" : "asc",
    };
  }, [sorting]);
  const handleSortChange = (next: DataGridSortState) => {
    onSortingChange([{ id: next.columnId, desc: next.direction === "desc" }]);
  };

  return (
    <FilterableDataGrid<JobSummary>
      title="Jobs table"
      data={data?.items ?? []}
      columns={columns}
      getRowId={(row) => row.jobKey}
      loading={loading}
      loadingMessage="Loading jobs."
      emptyMessage="No jobs match."
      initialSort={{ columnId: "discovered_at", direction: "desc" }}
      sort={gridSort}
      onSortChange={handleSortChange}
      manualSorting
      tableClassName="jobs-data-grid-table"
      rowAriaSelected={(row) =>
        allMatchingSelected || Boolean(rowSelection[row.jobKey])
      }
      onRowActivate={(row) => onOpenJob(row.jobKey)}
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
