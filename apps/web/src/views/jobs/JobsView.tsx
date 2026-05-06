import { type BulkJobMutationRequest, type JobSortField } from "@jobhunter/contracts";
import { Outlet, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useDeleteJobsBulkMutation } from "../../contexts/discovery/hooks/useDeleteJobsBulkMutation.js";
import { useRestoreJobsBulkMutation } from "../../contexts/discovery/hooks/useRestoreJobsBulkMutation.js";
import { useJobsListQuery } from "../../contexts/operations/hooks/useJobsListQuery.js";
import { CardHeader } from "../../shared/ui/card-header.js";
import { Pager } from "../../shared/ui/pager.js";
import type { JobsSearch } from "../../routes/-jobs.search.js";
import { JobBulkActions } from "./JobBulkActions.js";
import { JobFilterBar } from "./JobFilterBar.js";
import { JobsTable, type JobSortColumn } from "./JobsTable.js";

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

export function JobsView() {
  const search = useSearch({ from: "/jobs" });
  const navigate = useNavigate({ from: "/jobs" });

  const { data, isFetching, error } = useJobsListQuery(jobsListInput(search));
  const deleteJobs = useDeleteJobsBulkMutation();
  const restoreJobs = useRestoreJobsBulkMutation();
  const message = error instanceof Error ? error.message : null;

  const [selectedJobs, setSelectedJobs] = useState<Set<string>>(() => new Set());
  const [allMatchingSelected, setAllMatchingSelected] = useState(false);

  useEffect(() => {
    setSelectedJobs(new Set());
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

  const toggleSelection = (jobKey: string, selected: boolean) => {
    setAllMatchingSelected(false);
    setSelectedJobs((current) => {
      const next = new Set(current);
      if (selected) {
        next.add(jobKey);
      } else {
        next.delete(jobKey);
      }
      return next;
    });
  };

  const selectPage = () => {
    setAllMatchingSelected(false);
    setSelectedJobs(new Set(data?.items.map((job) => job.jobKey) ?? []));
  };

  const selectAllMatching = () => {
    setSelectedJobs(new Set());
    setAllMatchingSelected(Boolean(data?.pagination.total));
  };

  const clearSelection = () => {
    setSelectedJobs(new Set());
    setAllMatchingSelected(false);
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

  const changeSort = (field: JobSortColumn) => {
    if (search.sort === field) {
      setSearch({ dir: search.dir === "asc" ? "desc" : "asc", page: 1 });
      return;
    }
    setSearch({
      sort: field as JobSortField,
      dir: field === "discovered_at" || field === "fit_score" ? "desc" : "asc",
      page: 1,
    });
  };

  const restoring = search.deleted === "deleted";
  const mutation = restoring ? restoreJobs : deleteJobs;
  const mutateBusy = mutation.isPending;

  const mutateSelected = () => {
    const jobKeys = Array.from(selectedJobs);
    const count = allMatchingSelected ? (data?.pagination.total ?? 0) : jobKeys.length;
    if (!count) {
      return;
    }
    if (
      !window.confirm(
        `${restoring ? "Restore" : "Soft delete"} ${count} selected job${
          count === 1 ? "" : "s"
        }?`,
      )
    ) {
      return;
    }
    const payload: BulkJobMutationRequest = allMatchingSelected
      ? { allMatching: true, filter: currentJobFilter(), jobKeys: [] }
      : { allMatching: false, jobKeys };
    mutation.mutate(payload, {
      onSuccess: () => clearSelection(),
    });
  };

  const selectedCount = allMatchingSelected
    ? (data?.pagination.total ?? 0)
    : selectedJobs.size;

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
          onMutateSelected={mutateSelected}
        />
        <JobsTable
          data={data ?? null}
          loading={isFetching}
          sort={search.sort}
          dir={search.dir}
          selectedJobs={selectedJobs}
          allMatchingSelected={allMatchingSelected}
          onChangeSort={changeSort}
          onToggleSelection={toggleSelection}
          onOpenJob={openJob}
        />
        <Pager
          pagination={data?.pagination}
          page={search.page}
          onPage={(page) => setSearch({ page })}
        />
      </section>
      <Outlet />
    </>
  );
}
