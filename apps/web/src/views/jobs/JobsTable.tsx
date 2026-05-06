import type { RowSelectionState, SortingState } from "@tanstack/react-table";

import type { JobSummary, PaginatedResponse } from "../../contexts/operations/types.js";
import { DataTable } from "../../shared/ui/data-table.js";
import { TablePager } from "../../shared/ui/table-pager.js";
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
  return (
    <DataTable<JobSummary>
      data={data?.items ?? []}
      columns={jobColumns}
      getRowId={(row) => row.jobKey}
      loading={loading}
      loaded={data !== null}
      loadingMessage="Loading jobs."
      emptyMessage="No jobs match."
      headerClassName="data-row job job-header"
      rowClassName="data-row job"
      sorting={sorting}
      onSortingChange={onSortingChange}
      rowSelection={rowSelection}
      onRowSelectionChange={onRowSelectionChange}
      onRowActivate={(row) => onOpenJob(row.jobKey)}
      rowAriaSelected={(row) => allMatchingSelected || Boolean(rowSelection[row.jobKey])}
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
