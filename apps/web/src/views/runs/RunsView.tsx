import {
  WORKFLOW_RUN_SORT_FIELDS,
  type WorkflowRunSortField,
} from "@jobctrl/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { useMemo } from "react";

import { useWorkflowRunsListQuery } from "../../contexts/operations/hooks/useWorkflowRunsListQuery.js";
import type { WorkflowRunsListInput } from "../../contexts/operations/types.js";
import type { RunsSearch } from "../../routes/-runs.search.js";
import { PageHead } from "../../shared/ui/page-head.js";
import { RunsFilterBar } from "./RunsFilterBar.js";
import { RunsTable } from "./RunsTable.js";

// TODO(temporal): the JSON-RPC `cancel_run` handler + `CancelRunParamsSchema`
// already exist (PR 3 fixer). Wiring an in-row "Cancel running workflow"
// button is out of scope for PR 5 and lands in a follow-up.

function workflowRunsInput(search: RunsSearch): WorkflowRunsListInput {
  return {
    page: search.page,
    pageSize: search.pageSize,
    status: search.status,
    sort: search.sort,
    dir: search.dir,
  };
}

const SORTABLE_WORKFLOW_RUN_FIELDS: ReadonlySet<WorkflowRunSortField> = new Set(
  WORKFLOW_RUN_SORT_FIELDS,
);

function isWorkflowRunSortField(value: string): value is WorkflowRunSortField {
  return SORTABLE_WORKFLOW_RUN_FIELDS.has(value as WorkflowRunSortField);
}

export function RunsView() {
  const search = useSearch({ from: "/runs" });
  const navigate = useNavigate({ from: "/runs" });
  const { data, isFetching, error } = useWorkflowRunsListQuery(
    workflowRunsInput(search),
  );
  const message = error instanceof Error ? error.message : null;

  const setSearch = (next: Partial<RunsSearch>) => {
    void navigate({ search: (prev: RunsSearch) => ({ ...prev, ...next }) });
  };
  const sorting = useMemo<SortingState>(
    () => [{ id: search.sort, desc: search.dir === "desc" }],
    [search.dir, search.sort],
  );
  const handleSortingChange = (next: SortingState) => {
    const head = next[0];
    if (!head || !isWorkflowRunSortField(head.id)) {
      return;
    }
    setSearch({
      sort: head.id,
      dir: head.desc ? "desc" : "asc",
      page: 1,
    });
  };

  // The detail drawer route is `/runs/$runId`; clicking a row navigates
  // there. The table's `onRowActivate` already supplies the workflow id
  // (which equals `runId` for apply runs).
  const openRun = (workflowId: string) => {
    void navigate({ to: "/runs/$runId", params: { runId: workflowId } });
  };

  return (
    <>
      <PageHead
        eyebrow="Activity"
        title="Workflow runs"
        subtitle={data ? `${data.pagination.total} total` : "loading"}
      />
      <section className="card full data-list-card">
        {message ? <div className="banner inline">{message}</div> : null}
        <RunsFilterBar
          status={search.status}
          onStatusChange={(status) => setSearch({ status, page: 1 })}
        />
        <RunsTable
          data={data ?? null}
          loading={isFetching}
          sorting={sorting}
          onSortingChange={handleSortingChange}
          page={search.page}
          pageSize={search.pageSize}
          onPageChange={(page) => setSearch({ page })}
          onPageSizeChange={(pageSize) => setSearch({ pageSize, page: 1 })}
          onOpenRun={openRun}
        />
      </section>
    </>
  );
}
