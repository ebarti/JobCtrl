import type { SortingState } from "@tanstack/react-table";
import { useMemo } from "react";

import type {
  PaginatedResponse,
  WorkflowRunSummary,
} from "../../contexts/operations/types.js";
import {
  FilterableDataGrid,
  type DataGridSortState,
} from "../../shared/ui/filterable-data-grid.js";
import { workflowRunColumns } from "./columns.js";

export interface RunsTableProps {
  data: PaginatedResponse<WorkflowRunSummary> | null;
  loading: boolean;
  sorting: SortingState;
  onSortingChange: (next: SortingState) => void;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onOpenRun: (workflowId: string) => void;
}

export function RunsTable({
  data,
  loading,
  sorting,
  onSortingChange,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  onOpenRun,
}: RunsTableProps) {
  const gridSort = useMemo<DataGridSortState>(() => {
    const head = sorting[0];
    return {
      columnId: head?.id ?? "started_at",
      direction: head?.desc ? "desc" : "asc",
    };
  }, [sorting]);
  const handleSortChange = (next: DataGridSortState) => {
    onSortingChange([{ id: next.columnId, desc: next.direction === "desc" }]);
  };

  return (
    <FilterableDataGrid<WorkflowRunSummary>
      title="Workflow runs table"
      data={data?.items ?? []}
      columns={workflowRunColumns}
      getRowId={(row) => row.workflowId}
      loading={loading}
      loadingMessage="Loading workflow runs."
      emptyMessage="No workflow runs."
      initialSort={{ columnId: "started_at", direction: "desc" }}
      sort={gridSort}
      onSortChange={handleSortChange}
      manualSorting
      tableClassName="runs-data-grid-table"
      onRowActivate={(row) => onOpenRun(row.workflowId)}
      rowActivationLabel={(row) => `Open run ${row.title} ${row.workflowId}`}
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
