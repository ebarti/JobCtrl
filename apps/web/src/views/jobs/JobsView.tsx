import {
  type BulkJobMutationRequest,
  type JobMutationResponse,
  type JobSortField,
  type JobSummary,
  type Stage,
  STAGE_STATES,
} from "@jobhunter/contracts";
import { Outlet, useNavigate, useSearch } from "@tanstack/react-router";
import type { UseMutationResult } from "@tanstack/react-query";
import type { RowSelectionState, SortingState } from "@tanstack/react-table";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useDeleteJobsBulkMutation } from "../../contexts/discovery/hooks/useDeleteJobsBulkMutation.js";
import { useHideJobsBulkMutation } from "../../contexts/discovery/hooks/useHideJobsBulkMutation.js";
import { usePermanentlyDeleteJobsBulkMutation } from "../../contexts/discovery/hooks/usePermanentlyDeleteJobsBulkMutation.js";
import { useRestoreJobsBulkMutation } from "../../contexts/discovery/hooks/useRestoreJobsBulkMutation.js";
import { useUnhideJobsBulkMutation } from "../../contexts/discovery/hooks/useUnhideJobsBulkMutation.js";
import { useJobsListQuery } from "../../contexts/operations/hooks/useJobsListQuery.js";
import { useRetryFailedJobsMutation } from "../../contexts/pipeline/hooks/useRetryFailedJobsMutation.js";
import { useRunJobStageMutation } from "../../contexts/pipeline/hooks/useRunJobStageMutation.js";
import type { JobsSearch } from "../../routes/-jobs.search.js";
import { CardHeader } from "../../shared/ui/card-header.js";
import {
  hasActiveDataGridFilters,
  type DataGridFilterState,
  type DataGridTextFilter,
} from "../../shared/ui/filterable-data-grid.js";
import { JobBulkActions } from "./JobBulkActions.js";
import { JobsTable } from "./JobsTable.js";
import { bulkJobFilters, jobsListInput } from "./jobStageFilters.js";

const SORTABLE_JOB_FIELDS: ReadonlySet<JobSortField> = new Set([
  "discovered_at",
  "title",
  "company",
  "location",
  "fit_score",
  "current_stage",
  "current_state",
]);

type BulkJobMutation = UseMutationResult<
  JobMutationResponse,
  Error,
  BulkJobMutationRequest
>;

const SEARCH_FILTER_COLUMNS = new Set([
  "current_stage",
  "current_state",
  "apply_status",
]);
const JOB_TABLE_STAGE_FILTERS = ["discover", "apply"] as const;
const AUTONOMOUS_PICKUP_STAGES: ReadonlySet<Stage> = new Set(["enrich", "score", "tailor", "cover"]);

function filterFor(value: string | undefined): DataGridTextFilter | undefined {
  if (!value) return undefined;
  return { operator: "contains", text: "", selectedValues: [value] };
}

function firstAllowedValue<T extends string>(
  filter: DataGridTextFilter | undefined,
  allowed: readonly T[],
): T | undefined {
  return filter?.selectedValues.find((value): value is T =>
    allowed.includes(value as T),
  );
}

function searchFilters(search: JobsSearch): DataGridFilterState {
  return {
    ...(search.stage !== "all"
      ? { current_stage: filterFor(search.stage) }
      : {}),
    ...(search.state !== "all"
      ? { current_state: filterFor(search.state) }
      : {}),
    ...(search.applyStatus !== "all"
      ? { apply_status: filterFor(search.applyStatus) }
      : {}),
  };
}

function localFiltersOnly(filters: DataGridFilterState): DataGridFilterState {
  return Object.fromEntries(
    Object.entries(filters).filter(([columnId]) => !SEARCH_FILTER_COLUMNS.has(columnId)),
  );
}

function isJobSortField(value: string): value is JobSortField {
  return SORTABLE_JOB_FIELDS.has(value as JobSortField);
}

function sameKeys(
  current: readonly string[],
  next: readonly string[],
): boolean {
  return (
    current.length === next.length &&
    current.every((jobKey, index) => jobKey === next[index])
  );
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
  const retryFailedJobs = useRetryFailedJobsMutation();
  const runJobStage = useRunJobStageMutation();
  const message = error instanceof Error ? error.message : null;

  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [allMatchingSelected, setAllMatchingSelected] = useState(false);
  const [localTableFilters, setLocalTableFilters] =
    useState<DataGridFilterState>({});
  const [visiblePageKeys, setVisiblePageKeys] = useState<string[]>([]);
  const autoPickupKeys = useRef<Set<string>>(new Set());
  const tableFilters = useMemo<DataGridFilterState>(
    () => ({
      ...localTableFilters,
      ...searchFilters(search),
    }),
    [
      localTableFilters,
      search.applyStatus,
      search.stage,
      search.state,
    ],
  );
  const hasLocalFilters = hasActiveDataGridFilters(localTableFilters);

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
    search.applyStatus,
    search.minFitScore,
    search.maxFitScore,
  ]);
  useEffect(() => {
    setRowSelection({});
    setAllMatchingSelected(false);
  }, [localTableFilters]);

  const setSearch = useCallback(
    (next: Partial<JobsSearch>) => {
      void navigate({ search: (prev: JobsSearch) => ({ ...prev, ...next }) });
    },
    [navigate],
  );

  const handleTableFiltersChange = useCallback(
    (next: DataGridFilterState) => {
      setLocalTableFilters(localFiltersOnly(next));
      const nextStage =
        firstAllowedValue(next.current_stage, JOB_TABLE_STAGE_FILTERS) ?? "all";
      const nextState =
        firstAllowedValue(next.current_state, STAGE_STATES) ?? "all";
      const applyFilter = firstAllowedValue(next.apply_status, ["applied"] as const);
      const nextApplyStatus = applyFilter ?? "all";
      if (
        nextStage !== search.stage ||
        nextState !== search.state ||
        nextApplyStatus !== search.applyStatus
      ) {
        setSearch({
          stage: nextStage,
          state: nextState,
          applyStatus: nextApplyStatus,
          page: 1,
        });
      }
    },
    [search.applyStatus, search.stage, search.state, setSearch],
  );

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
    () =>
      Object.entries(rowSelection)
        .filter(([, on]) => on)
        .map(([key]) => key),
    [rowSelection],
  );
  const staleKeysOnPage = useMemo(
    () =>
      (data?.items ?? [])
        .filter((job) => job.scoreStaleness.isStale)
        .map((job) => job.jobKey),
    [data?.items],
  );
  const selectedStaleKeys = useMemo(
    () =>
      allMatchingSelected
        ? []
        : selectedKeys.filter((jobKey) => staleKeysOnPage.includes(jobKey)),
    [allMatchingSelected, selectedKeys, staleKeysOnPage],
  );

  useEffect(() => {
    for (const job of data?.items ?? []) {
      if (job.currentState !== "pending" || !AUTONOMOUS_PICKUP_STAGES.has(job.currentSubstage)) {
        continue;
      }
      const pickupKey = `${job.jobKey}:${job.currentSubstage}`;
      if (autoPickupKeys.current.has(pickupKey)) {
        continue;
      }
      autoPickupKeys.current.add(pickupKey);
      runJobStage.mutate({ jobId: job.jobKey, stage: job.currentSubstage });
    }
  }, [data?.items, runJobStage]);

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
    const next: RowSelectionState = {};
    for (const jobKey of visiblePageKeys) {
      next[jobKey] = true;
    }
    setRowSelection(next);
  };
  const handleVisiblePageRowsChange = useCallback(
    (rows: readonly JobSummary[]) => {
      const next = rows.map((row) => row.jobKey);
      setVisiblePageKeys((current) =>
        sameKeys(current, next) ? current : next,
      );
    },
    [],
  );

  const restoring = search.deleted === "deleted";
  const hidden = search.deleted === "hidden";
  const primaryMutation = hidden
    ? unhideJobs
    : restoring
      ? restoreJobs
      : deleteJobs;
  const mutateBusy =
    deleteJobs.isPending ||
    hideJobs.isPending ||
    permanentlyDeleteJobs.isPending ||
    restoreJobs.isPending ||
    unhideJobs.isPending ||
    retryFailedJobs.isPending ||
    runJobStage.isPending;

  const selectedPayloads = (): BulkJobMutationRequest[] =>
    allMatchingSelected
      ? bulkJobFilters(search).map((filter) => ({
          allMatching: true,
          filter,
          jobKeys: [],
        }))
      : [{ allMatching: false, jobKeys: selectedKeys }];

  const mutatePayloads = (
    mutation: BulkJobMutation,
    payloads: readonly BulkJobMutationRequest[],
  ) => {
    if (payloads.length === 1) {
      mutation.mutate(payloads[0]!, {
        onSuccess: () => clearSelection(),
      });
      return;
    }
    void Promise.all(payloads.map((payload) => mutation.mutateAsync(payload)))
      .then(() => clearSelection())
      .catch(() => undefined);
  };

  const mutateSelected = (mutation: BulkJobMutation, label: string) => {
    const count = allMatchingSelected
      ? (data?.pagination.total ?? 0)
      : selectedKeys.length;
    if (!count) {
      return;
    }
    if (
      !window.confirm(
        `${label} ${count} selected job${count === 1 ? "" : "s"}?`,
      )
    ) {
      return;
    }
    mutatePayloads(mutation, selectedPayloads());
  };

  const mutatePrimarySelected = () => {
    mutateSelected(
      primaryMutation,
      hidden ? "Unhide" : restoring ? "Restore" : "Delete",
    );
  };

  const hideSelected = () => {
    mutateSelected(hideJobs, "Hide");
  };

  const retryFailedSelected = () => {
    mutateSelected(retryFailedJobs, "Retry");
  };

  const retryAllFailed = () => {
    if (!window.confirm("Retry all failed jobs matching the current filters?")) {
      return;
    }
    mutatePayloads(
      retryFailedJobs,
      bulkJobFilters(search, { deleted: "active", state: "failed" }).map(
        (filter) => ({
          allMatching: true,
          filter,
          jobKeys: [],
        }),
      ),
    );
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
        <CardHeader
          title="Jobs"
          meta={data ? `${data.pagination.total} total` : "loading"}
        />
        {message ? <div className="banner inline">{message}</div> : null}
        <JobBulkActions
          search={search}
          selectedCount={selectedCount}
          selectedJobKeys={allMatchingSelected ? [] : selectedKeys}
          staleCount={staleKeysOnPage.length}
          selectedStaleKeys={selectedStaleKeys}
          hasItems={visiblePageKeys.length > 0}
          hasAnyMatching={Boolean(data?.pagination.total)}
          hasLocalFilters={hasLocalFilters}
          loading={mutateBusy || isFetching}
          onSetDeleted={(deleted) => setSearch({ deleted, page: 1 })}
          onSelectPage={selectPage}
          onSelectAllMatching={selectAllMatching}
          onClearSelection={clearSelection}
          onPrimaryAction={mutatePrimarySelected}
          onHideSelected={hideSelected}
          onPermanentlyDeleteSelected={permanentlyDeleteSelected}
          onRetryFailedSelected={retryFailedSelected}
          onRetryAllFailed={retryAllFailed}
          onResetStaleSuccess={clearSelection}
          onMaintenanceSuccess={clearSelection}
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
          filters={tableFilters}
          onFiltersChange={handleTableFiltersChange}
          onVisiblePageRowsChange={handleVisiblePageRowsChange}
        />
      </section>
      <Outlet />
    </>
  );
}
