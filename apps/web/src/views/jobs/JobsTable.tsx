import type { RowSelectionState, SortingState } from "@tanstack/react-table";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import type {
  JobSummary,
  PaginatedResponse,
} from "../../contexts/operations/types.js";
import {
  FilterableDataGrid,
  type DataGridColorRule,
  type DataGridColumn,
  type DataGridColumnWidthsState,
  type DataGridDensity,
  type DataGridFilterState,
  type DataGridGroupingState,
  type DataGridSortState,
} from "../../shared/ui/filterable-data-grid.js";
import { jobColumns } from "./columns.js";

const EMPTY_FILTERS: DataGridFilterState = {};
const noopFiltersChange = () => {};
const noopVisiblePageRowsChange = () => {};

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
  filters?: DataGridFilterState;
  onFiltersChange?: (next: DataGridFilterState) => void;
  onVisiblePageRowsChange?: (rows: readonly JobSummary[]) => void;
  columnOrder?: readonly string[];
  hiddenColumnIds?: readonly string[];
  columnWidths?: DataGridColumnWidthsState;
  onColumnWidthsChange?: (next: DataGridColumnWidthsState) => void;
  density?: DataGridDensity | null;
  grouping?: DataGridGroupingState | null;
  colorRules?: readonly DataGridColorRule[];
  toolbarActions?: (columns: Array<DataGridColumn<JobSummary>>) => ReactNode;
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
  filters = EMPTY_FILTERS,
  onFiltersChange = noopFiltersChange,
  onVisiblePageRowsChange = noopVisiblePageRowsChange,
  columnOrder,
  hiddenColumnIds = [],
  columnWidths,
  onColumnWidthsChange,
  density,
  grouping,
  colorRules,
  toolbarActions,
}: JobsTableProps) {
  const [selectionAnchorJobKey, setSelectionAnchorJobKey] = useState<
    string | null
  >(null);
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
  useEffect(() => {
    if (!allMatchingSelected && !Object.values(rowSelection).some(Boolean)) {
      setSelectionAnchorJobKey(null);
    }
  }, [allMatchingSelected, rowSelection]);
  const columns = useMemo(
    () =>
      jobColumns({
        rowSelection: displayedRowSelection,
        onRowSelectionChange,
        selectionAnchorJobKey,
        onSelectionAnchorChange: setSelectionAnchorJobKey,
      }),
    [displayedRowSelection, onRowSelectionChange, selectionAnchorJobKey],
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
  const columnVisibility = useMemo(
    () =>
      Object.fromEntries(hiddenColumnIds.map((columnId) => [columnId, false])),
    [hiddenColumnIds],
  );
  const renderedToolbarActions = useMemo(
    () => toolbarActions?.(columns),
    [columns, toolbarActions],
  );

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
      mobileLayout="cards"
      sort={gridSort}
      onSortChange={handleSortChange}
      manualSorting
      filters={filters}
      onFiltersChange={onFiltersChange}
      columnVisibility={columnVisibility}
      toolbarActions={renderedToolbarActions}
      {...(columnOrder ? { columnOrder } : {})}
      {...(columnWidths ? { columnWidths } : {})}
      {...(onColumnWidthsChange ? { onColumnWidthsChange } : {})}
      {...(density !== undefined ? { density } : {})}
      {...(grouping !== undefined ? { grouping } : {})}
      {...(colorRules ? { colorRules } : {})}
      tableClassName="jobs-data-grid-table"
      rowAriaSelected={(row) =>
        allMatchingSelected || Boolean(rowSelection[row.jobKey])
      }
      onRowActivate={(row) => onOpenJob(row.jobKey)}
      rowActivationLabel={(row) =>
        `Open job ${row.title} at ${row.company || "unknown company"}`
      }
      rowActivationAppearance="focus-only"
      onPageRowsChange={onVisiblePageRowsChange}
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
