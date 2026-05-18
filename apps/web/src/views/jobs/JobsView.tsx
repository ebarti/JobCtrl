import { type BulkJobMutationRequest, type JobSortField } from "@jobhunter/contracts";
import { Outlet, useNavigate, useSearch } from "@tanstack/react-router";
import type { RowSelectionState, SortingState } from "@tanstack/react-table";
import { useEffect, useMemo, useState } from "react";

import { useDeleteJobsBulkMutation } from "../../contexts/discovery/hooks/useDeleteJobsBulkMutation.js";
import { useHideJobsBulkMutation } from "../../contexts/discovery/hooks/useHideJobsBulkMutation.js";
import { usePermanentlyDeleteJobsBulkMutation } from "../../contexts/discovery/hooks/usePermanentlyDeleteJobsBulkMutation.js";
import { useRestoreJobsBulkMutation } from "../../contexts/discovery/hooks/useRestoreJobsBulkMutation.js";
import { useUnhideJobsBulkMutation } from "../../contexts/discovery/hooks/useUnhideJobsBulkMutation.js";
import { useJobsListQuery } from "../../contexts/operations/hooks/useJobsListQuery.js";
import type { JobsSearch } from "../../routes/-jobs.search.js";
import { CardHeader } from "../../shared/ui/card-header.js";
import { JobBulkActions } from "./JobBulkActions.js";
import { JobFilterBar } from "./JobFilterBar.js";
import { JobsTable } from "./JobsTable.js";

function jobsListInput(search: JobsSearch) {
  return {
    page: search.page,
    pageSize: search.pageSize,
    q: search.q,
    sort: search.sort,
    dir: search.dir,
    deleted: search.deleted,
    ...(search.stage !== "all" ? { stage: search.stage } : {}),
    ...(search.state !== "all" ? { state: search.state } : {}),
  };
}

const SORTABLE_JOB_FIELDS: ReadonlySet<JobSortField> = new Set([
  "discovered_at",
  "title",
  "company",
  "location",
  "fit_score",
  "current_stage",
  "current_state",
]);

function isJobSortField(value: string): value is JobSortField {
  return SORTABLE_JOB_FIELDS.has(value as JobSortField);
}

export function JobsView() {
  const search = useSearch({ from: "/jobs" });
  const navigate = useNavigate({ from: "/jobs" });

  const { data, isFetching, error } = useJobsListQuery(jobsListInput(search));
  const deleteJobs = useDeleteJobsBulkMutation();
  const hideJobs = useHideJobsBulkMutation();
  const permanentlyDeleteJobs = usePermanentlyDeleteJobsBulkMutation();
  const restoreJobs = useRestoreJobsBulkMutation();
  const unhideJobs = useUnhideJobsBulkMutation();
  const message = error instanceof Error ? error.message : null;

  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [allMatchingSelected, setAllMatchingSelected] = useState(false);

  useEffect(() => {
    setRowSelection({});
    setAllMatchingSelected(false);
  }, [
    search.deleted,
    search.dir,
    search.page,
    search.pageSize,
    search.q,
    search.sort,
    search.stage,
    search.state,
  ]);

  const setSearch = (next: Partial<JobsSearch>) => {
    void navigate({ search: (prev: JobsSearch) => ({ ...prev, ...next }) });
  };

  const sorting = useMemo<SortingState>(
    () => [{ id: search.sort, desc: search.dir === "desc" }],
    [search.sort, search.dir],
  );

  const handleSortingChange = (next: SortingState) => {
    const head = next[0];
    if (!head || !isJobSortField(head.id)) {
      return;
    }
    setSearch({
      sort: head.id,
      dir: head.desc ? "desc" : "asc",
      page: 1,
    });
  };

  const handleRowSelectionChange = (next: RowSelectionState) => {
    setAllMatchingSelected(false);
    setRowSelection(next);
  };

  const selectedKeys = useMemo(
    () => Object.entries(rowSelection).filter(([, on]) => on).map(([key]) => key),
    [rowSelection],
  );

  const selectAllMatching = () => {
    setRowSelection({});
    setAllMatchingSelected(Boolean(data?.pagination.total));
  };

  const clearSelection = () => {
    setRowSelection({});
    setAllMatchingSelected(false);
  };

  const selectPage = () => {
    setAllMatchingSelected(false);
    const items = data?.items ?? [];
    const next: RowSelectionState = {};
    for (const job of items) {
      next[job.jobKey] = true;
    }
    setRowSelection(next);
  };

  const currentJobFilter = (): NonNullable<BulkJobMutationRequest["filter"]> => {
    const filter: NonNullable<BulkJobMutationRequest["filter"]> = {
      q: search.q,
      deleted: search.deleted,
      source: "",
      company: "",
    };
    if (search.stage !== "all") {
      filter.stage = search.stage;
    }
    if (search.state !== "all") {
      filter.state = search.state;
    }
    return filter;
  };

  const restoring = search.deleted === "deleted";
  const hidden = search.deleted === "hidden";
  const primaryMutation = hidden ? unhideJobs : restoring ? restoreJobs : deleteJobs;
  const mutateBusy =
    deleteJobs.isPending ||
    hideJobs.isPending ||
    permanentlyDeleteJobs.isPending ||
    restoreJobs.isPending ||
    unhideJobs.isPending;

  const selectedPayload = (): BulkJobMutationRequest =>
    allMatchingSelected
      ? { allMatching: true, filter: currentJobFilter(), jobKeys: [] }
      : { allMatching: false, jobKeys: selectedKeys };

  const mutateSelected = (
    mutation: typeof deleteJobs,
    label: string,
  ) => {
    const count = allMatchingSelected ? (data?.pagination.total ?? 0) : selectedKeys.length;
    if (!count) {
      return;
    }
    if (!window.confirm(`${label} ${count} selected job${count === 1 ? "" : "s"}?`)) {
      return;
    }
    mutation.mutate(selectedPayload(), {
      onSuccess: () => clearSelection(),
    });
  };

  const mutatePrimarySelected = () => {
    mutateSelected(primaryMutation, hidden ? "Unhide" : restoring ? "Restore" : "Delete");
  };

  const hideSelected = () => {
    mutateSelected(hideJobs, "Hide");
  };

  const permanentlyDeleteSelected = () => {
    mutateSelected(permanentlyDeleteJobs, "Permanently delete");
  };

  const selectedCount = allMatchingSelected
    ? (data?.pagination.total ?? 0)
    : selectedKeys.length;

  const openJob = (jobKey: string) => {
    void navigate({
      to: "/jobs/$jobId",
      params: { jobId: jobKey },
      search: (prev: JobsSearch) => prev,
    });
  };

  return (
    <>
      <section className="card full">
        <CardHeader title="Jobs" meta={data ? `${data.pagination.total} total` : "loading"} />
        {message ? <div className="banner inline">{message}</div> : null}
        <JobFilterBar search={search} />
        <JobBulkActions
          search={search}
          selectedCount={selectedCount}
          hasItems={Boolean(data?.items.length)}
          hasAnyMatching={Boolean(data?.pagination.total)}
          loading={mutateBusy || isFetching}
          onSetDeleted={(deleted) => setSearch({ deleted, page: 1 })}
          onSelectPage={selectPage}
          onSelectAllMatching={selectAllMatching}
          onClearSelection={clearSelection}
          onPrimaryAction={mutatePrimarySelected}
          onHideSelected={hideSelected}
          onPermanentlyDeleteSelected={permanentlyDeleteSelected}
        />
        <JobsTable
          data={data ?? null}
          loading={isFetching}
          sorting={sorting}
          onSortingChange={handleSortingChange}
          rowSelection={rowSelection}
          onRowSelectionChange={handleRowSelectionChange}
          allMatchingSelected={allMatchingSelected}
          page={search.page}
          pageSize={search.pageSize}
          onPageChange={(page) => setSearch({ page })}
          onPageSizeChange={(pageSize) => setSearch({ pageSize, page: 1 })}
          onOpenJob={openJob}
        />
      </section>
      <Outlet />
    </>
  );
}
