import type { SortingState } from "@tanstack/react-table";

import type { PaginatedResponse, WorkflowRunSummary } from "../../contexts/operations/types.js";
import { DataTable } from "../../shared/ui/data-table.js";
import { TablePager } from "../../shared/ui/table-pager.js";
import { workflowRunColumns } from "./columns.js";

export interface RunsTableProps {
  data: PaginatedResponse<WorkflowRunSummary> | null;
  loading: boolean;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onOpenRun: (workflowId: string) => void;
}

const NO_SORTING: SortingState = [];

export function RunsTable({
  data,
  loading,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  onOpenRun,
}: RunsTableProps) {
  return (
    <DataTable<WorkflowRunSummary>
      data={data?.items ?? []}
      columns={workflowRunColumns}
      getRowId={(row) => row.workflowId}
      loading={loading}
      loaded={data !== null}
      loadingMessage="Loading workflow runs."
      emptyMessage="No workflow runs."
      headerClassName="data-row run run-header"
      rowClassName="data-row run"
      sorting={NO_SORTING}
      onSortingChange={() => undefined}
      enableRowSelection={false}
      rowSelection={{}}
      onRowSelectionChange={() => undefined}
      onRowActivate={(row) => onOpenRun(row.workflowId)}
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
