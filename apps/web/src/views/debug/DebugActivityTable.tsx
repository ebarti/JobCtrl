import type { SortingState } from "@tanstack/react-table";
import { useMemo } from "react";

import type {
  ActivityEventSummary,
  PaginatedResponse,
} from "../../contexts/operations/types.js";
import {
  FilterableDataGrid,
  type DataGridSortState,
} from "../../shared/ui/filterable-data-grid.js";
import { activityColumns } from "./activity-columns.js";

export interface DebugActivityTableProps {
  data: PaginatedResponse<ActivityEventSummary> | null;
  loading: boolean;
  sorting: SortingState;
  onSortingChange: (next: SortingState) => void;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onOpenActivity: (eventId: string) => void;
}

export function DebugActivityTable({
  data,
  loading,
  sorting,
  onSortingChange,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  onOpenActivity,
}: DebugActivityTableProps) {
  const gridSort = useMemo<DataGridSortState>(() => {
    const head = sorting[0];
    return {
      columnId: head?.id ?? "occurred_at",
      direction: head?.desc ? "desc" : "asc",
    };
  }, [sorting]);
  const handleSortChange = (next: DataGridSortState) => {
    onSortingChange([{ id: next.columnId, desc: next.direction === "desc" }]);
  };

  return (
    <FilterableDataGrid<ActivityEventSummary>
      title="Recent activity"
      data={data?.items ?? []}
      columns={activityColumns}
      getRowId={(activity) => activity.eventId}
      loading={loading}
      loadingMessage="Loading activity."
      emptyMessage="No activity events match."
      initialSort={{ columnId: "occurred_at", direction: "desc" }}
      sort={gridSort}
      onSortChange={handleSortChange}
      manualSorting
      tableClassName="activity-data-grid-table"
      onRowActivate={(activity) => onOpenActivity(activity.eventId)}
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
