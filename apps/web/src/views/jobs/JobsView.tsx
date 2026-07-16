import {
  DEFAULT_PIPELINE_LLM_MODEL,
  type BulkJobMutationRequest,
  type BulkRunPendingPreparationRequest,
  type BulkRetryFailedRequest,
  type JobMutationResponse,
  type JobSortField,
  type JobSummary,
  type SavedTableView,
  STAGE_STATES,
} from "@jobctrl/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { UseMutationResult } from "@tanstack/react-query";
import type { RowSelectionState, SortingState } from "@tanstack/react-table";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useDeleteJobsBulkMutation } from "../../contexts/discovery/hooks/useDeleteJobsBulkMutation.js";
import { useHideJobsBulkMutation } from "../../contexts/discovery/hooks/useHideJobsBulkMutation.js";
import { usePermanentlyDeleteJobsBulkMutation } from "../../contexts/discovery/hooks/usePermanentlyDeleteJobsBulkMutation.js";
import { useRestoreJobsBulkMutation } from "../../contexts/discovery/hooks/useRestoreJobsBulkMutation.js";
import { useUnhideJobsBulkMutation } from "../../contexts/discovery/hooks/useUnhideJobsBulkMutation.js";
import { useJobsListQuery } from "../../contexts/operations/hooks/useJobsListQuery.js";
import { useRetryFailedJobsMutation } from "../../contexts/pipeline/hooks/useRetryFailedJobsMutation.js";
import { useRunPendingPreparationMutation } from "../../contexts/pipeline/hooks/useRunPendingPreparationMutation.js";
import { useStageTriggerStore } from "../../contexts/pipeline/stores/stage-trigger-store.js";
import type { JobsSearch } from "../../routes/-jobs.search.js";
import {
  JOBS_TABLE_COLUMN_IDS,
  JOBS_TABLE_ID,
  DEFAULT_SAVED_TABLE_VIEW_ID,
  type SavedTablePresentation,
  type SavedTableViewSnapshot,
  useSavedTableViewsStore,
} from "../../shared/stores/saved-table-views.js";
import { PageHead } from "../../shared/ui/page-head.js";
import {
  type DataGridColumn,
  type DataGridColumnWidthsState,
  hasActiveDataGridFilters,
  type DataGridFilterState,
  type DataGridTextFilter,
} from "../../shared/ui/filterable-data-grid.js";
import {
  SavedTableViewsControl,
  type SavedTableColumnOption,
} from "../../shared/ui/saved-table-views-control.js";
import { JobBulkActions } from "./JobBulkActions.js";
import { JobsTable } from "./JobsTable.js";
import { bulkJobFilters, jobsListInput } from "./jobStageFilters.js";

const SORTABLE_JOB_FIELDS: ReadonlySet<JobSortField> = new Set([
  "discovered_at",
  "title",
  "company",
  "source",
  "compensation_min_eur",
  "compensation_max_eur",
  "compensation_posted",
  "compensation_market",
  "compensation_confidence",
  "compensation_warnings",
  "location",
  "fit_score",
  "current_stage",
  "current_state",
  "apply_status",
]);

type BulkJobMutation = UseMutationResult<
  JobMutationResponse,
  Error,
  BulkJobMutationRequest
>;
type RetryFailedMutation = ReturnType<typeof useRetryFailedJobsMutation>;
type RunPendingPreparationMutation = ReturnType<
  typeof useRunPendingPreparationMutation
>;

const SEARCH_FILTER_COLUMNS = new Set([
  "current_stage",
  "current_state",
  "apply_status",
]);
const JOB_TABLE_STAGE_FILTERS = ["discover", "apply"] as const;
const DEFAULT_JOBS_HIDDEN_COLUMN_IDS = [
  "source",
  "compensation_warnings",
] as const;
const DEFAULT_JOBS_PRESENTATION: SavedTablePresentation = {
  columns: {
    order: [...JOBS_TABLE_COLUMN_IDS],
    hidden: [...DEFAULT_JOBS_HIDDEN_COLUMN_IDS],
    widths: {},
  },
  density: null,
  grouping: null,
  colorRules: [],
};
const DEFAULT_SAVED_URL_FILTERS = {
  q: "",
  stage: "all",
  state: "all",
  applyStatus: "all",
  deleted: "active",
  pageSize: 50,
  minFitScore: undefined,
  maxFitScore: undefined,
  discoveredSince: undefined,
  scoredSince: undefined,
} satisfies SavedTableViewSnapshot["urlFilters"];

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
    Object.entries(filters).filter(
      ([columnId]) => !SEARCH_FILTER_COLUMNS.has(columnId),
    ),
  );
}

function boundedInt(
  value: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function retryWorkersFromConfigs(
  configs: ReturnType<typeof useStageTriggerStore.getState>["configs"],
): number {
  return Math.max(
    boundedInt(configs.discover.workers, 1, 1, 16),
    boundedInt(configs.score.workers, 1, 1, 16),
    boundedInt(configs.tailor.workers, 1, 1, 16),
  );
}

function retryRunOptions(
  configs: ReturnType<typeof useStageTriggerStore.getState>["configs"],
): Pick<
  BulkRetryFailedRequest,
  "runAfter" | "workers" | "minScore" | "validationMode" | "dryRun" | "llmModel"
> {
  return {
    runAfter: true,
    workers: retryWorkersFromConfigs(configs),
    minScore: boundedInt(configs.tailor.minScore, 7, 0, 10),
    validationMode: configs.tailor.validationMode,
    dryRun: false,
    llmModel: DEFAULT_PIPELINE_LLM_MODEL,
  };
}

function pendingPreparationRunOptions(
  configs: ReturnType<typeof useStageTriggerStore.getState>["configs"],
): Pick<
  BulkRunPendingPreparationRequest,
  "workers" | "minScore" | "validationMode" | "dryRun" | "llmModel"
> {
  return {
    workers: retryWorkersFromConfigs(configs),
    minScore: boundedInt(configs.tailor.minScore, 7, 0, 10),
    validationMode: configs.tailor.validationMode,
    dryRun: false,
    llmModel: DEFAULT_PIPELINE_LLM_MODEL,
  };
}

function isJobSortField(value: string): value is JobSortField {
  return SORTABLE_JOB_FIELDS.has(value as JobSortField);
}

function savedUrlFiltersFromSearch(
  search: JobsSearch,
): SavedTableViewSnapshot["urlFilters"] {
  return {
    q: search.q,
    stage: search.stage,
    state: search.state,
    applyStatus: search.applyStatus,
    deleted: search.deleted,
    pageSize: search.pageSize,
    minFitScore: search.minFitScore,
    maxFitScore: search.maxFitScore,
    discoveredSince: search.discoveredSince,
    scoredSince: search.scoredSince,
  };
}

function searchPatchFromSavedView(view: SavedTableView): Partial<JobsSearch> {
  const filters = { ...DEFAULT_SAVED_URL_FILTERS, ...view.urlFilters };
  return {
    q: filters.q ?? "",
    stage: filters.stage ?? "all",
    state: filters.state ?? "all",
    applyStatus: filters.applyStatus ?? "all",
    deleted: filters.deleted ?? "active",
    pageSize: filters.pageSize ?? 50,
    minFitScore: filters.minFitScore,
    maxFitScore: filters.maxFitScore,
    discoveredSince: filters.discoveredSince,
    scoredSince: filters.scoredSince,
    sort: isJobSortField(view.sort.columnId)
      ? view.sort.columnId
      : "discovered_at",
    dir: view.sort.direction,
    page: 1,
  };
}

function columnOptionsFor(
  columns: Array<DataGridColumn<JobSummary>>,
): SavedTableColumnOption[] {
  return columns.map((column) => ({
    id: column.id,
    label: column.label,
    locked: column.id === "select",
  }));
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
  const runPendingPreparation = useRunPendingPreparationMutation();
  const stageTriggerConfigs = useStageTriggerStore((state) => state.configs);
  const savedTableViews = useSavedTableViewsStore((state) => state.views);
  const activeSavedViewId = useSavedTableViewsStore(
    (state) =>
      state.activeViewIdByTable[JOBS_TABLE_ID] ?? DEFAULT_SAVED_TABLE_VIEW_ID,
  );
  const savedPresentation =
    useSavedTableViewsStore(
      (state) => state.presentationByTable[JOBS_TABLE_ID],
    ) ?? DEFAULT_JOBS_PRESENTATION;
  const setSavedPresentation = useSavedTableViewsStore(
    (state) => state.setTablePresentation,
  );
  const message = error instanceof Error ? error.message : null;

  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [allMatchingSelected, setAllMatchingSelected] = useState(false);
  const [localTableFilters, setLocalTableFilters] =
    useState<DataGridFilterState>({});
  const [visiblePageKeys, setVisiblePageKeys] = useState<string[]>([]);
  const activeSavedView = useMemo(
    () =>
      savedTableViews.find(
        (view) =>
          view.tableId === JOBS_TABLE_ID && view.id === activeSavedViewId,
      ) ?? null,
    [activeSavedViewId, savedTableViews],
  );
  const tableFilters = useMemo<DataGridFilterState>(
    () => ({
      ...localTableFilters,
      ...searchFilters(search),
    }),
    [localTableFilters, search.applyStatus, search.stage, search.state],
  );

  useEffect(() => {
    setLocalTableFilters(
      (activeSavedView?.gridFilters ?? {}) as DataGridFilterState,
    );
  }, [activeSavedView?.gridFilters]);

  const hasLocalFilters = hasActiveDataGridFilters(localTableFilters);
  const savedViewSnapshot = useMemo<SavedTableViewSnapshot>(
    () => ({
      ...savedPresentation,
      sort: { columnId: search.sort, direction: search.dir },
      urlFilters: savedUrlFiltersFromSearch(search),
      gridFilters: localTableFilters,
    }),
    [
      localTableFilters,
      savedPresentation,
      search.applyStatus,
      search.deleted,
      search.dir,
      search.discoveredSince,
      search.maxFitScore,
      search.minFitScore,
      search.pageSize,
      search.q,
      search.scoredSince,
      search.sort,
      search.stage,
      search.state,
    ],
  );

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

  const handleSavedPresentationChange = useCallback(
    (presentation: SavedTablePresentation) => {
      setSavedPresentation(JOBS_TABLE_ID, presentation);
    },
    [setSavedPresentation],
  );

  const handleColumnWidthsChange = useCallback(
    (widths: DataGridColumnWidthsState) => {
      setSavedPresentation(JOBS_TABLE_ID, {
        ...savedPresentation,
        columns: { ...savedPresentation.columns, widths },
      });
    },
    [savedPresentation, setSavedPresentation],
  );

  const handleSavedViewApply = useCallback(
    (view: SavedTableView) => {
      setLocalTableFilters(view.gridFilters as DataGridFilterState);
      setSearch(searchPatchFromSavedView(view));
    },
    [setSearch],
  );

  const renderSavedTableActions = useCallback(
    (columns: Array<DataGridColumn<JobSummary>>) => (
      <SavedTableViewsControl
        tableId={JOBS_TABLE_ID}
        columnOptions={columnOptionsFor(columns)}
        snapshot={savedViewSnapshot}
        onApplyView={handleSavedViewApply}
        onPresentationChange={handleSavedPresentationChange}
      />
    ),
    [handleSavedPresentationChange, handleSavedViewApply, savedViewSnapshot],
  );

  const handleTableFiltersChange = useCallback(
    (next: DataGridFilterState) => {
      setLocalTableFilters(localFiltersOnly(next));
      const nextStage =
        firstAllowedValue(next.current_stage, JOB_TABLE_STAGE_FILTERS) ?? "all";
      const nextState =
        firstAllowedValue(next.current_state, STAGE_STATES) ?? "all";
      const applyFilter = firstAllowedValue(next.apply_status, [
        "applied",
      ] as const);
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
  const selectionMutationBusy =
    deleteJobs.isPending ||
    hideJobs.isPending ||
    permanentlyDeleteJobs.isPending ||
    restoreJobs.isPending ||
    unhideJobs.isPending;

  const selectedPayloads = (): BulkJobMutationRequest[] =>
    allMatchingSelected
      ? bulkJobFilters(search).map((filter) => ({
          allMatching: true,
          filter,
          jobKeys: [],
        }))
      : [{ allMatching: false, jobKeys: selectedKeys }];

  const selectedRetryPayloads = (): BulkRetryFailedRequest[] =>
    selectedPayloads().map((payload) => ({
      ...payload,
      ...retryRunOptions(stageTriggerConfigs),
    }));

  const pendingPreparationPayloads = (): BulkRunPendingPreparationRequest[] =>
    bulkJobFilters(search, { deleted: "active", state: "pending" }).map(
      (filter) => ({
        allMatching: true,
        filter,
        jobKeys: [],
        ...pendingPreparationRunOptions(stageTriggerConfigs),
      }),
    );

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

  const mutateRetryPayloads = (
    mutation: RetryFailedMutation,
    payloads: readonly BulkRetryFailedRequest[],
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

  const mutatePendingPreparationPayloads = (
    mutation: RunPendingPreparationMutation,
    payloads: readonly BulkRunPendingPreparationRequest[],
    options?: { clearSelectionOnSuccess?: boolean },
  ) => {
    if (payloads.length === 1) {
      if (options?.clearSelectionOnSuccess === false) {
        mutation.mutate(payloads[0]!);
        return;
      }
      mutation.mutate(payloads[0]!, {
        onSuccess: () => clearSelection(),
      });
      return;
    }
    void Promise.all(payloads.map((payload) => mutation.mutateAsync(payload)))
      .then(() => {
        if (options?.clearSelectionOnSuccess !== false) {
          clearSelection();
        }
      })
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
    const count = allMatchingSelected
      ? (data?.pagination.total ?? 0)
      : selectedKeys.length;
    if (!count) {
      return;
    }
    if (
      !window.confirm(`Retry ${count} selected job${count === 1 ? "" : "s"}?`)
    ) {
      return;
    }
    mutateRetryPayloads(retryFailedJobs, selectedRetryPayloads());
  };

  const retryAllFailed = () => {
    if (
      !window.confirm("Retry all failed jobs matching the current filters?")
    ) {
      return;
    }
    mutateRetryPayloads(
      retryFailedJobs,
      bulkJobFilters(search, { deleted: "active", state: "failed" }).map(
        (filter) => ({
          allMatching: true,
          filter,
          jobKeys: [],
          ...retryRunOptions(stageTriggerConfigs),
        }),
      ),
    );
  };

  const continuePendingPreparation = () => {
    if (
      !window.confirm(
        "Continue pending preparation for matching active jobs? This will not run apply.",
      )
    ) {
      return;
    }
    mutatePendingPreparationPayloads(
      runPendingPreparation,
      pendingPreparationPayloads(),
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
      <PageHead
        className="jobs-page-head"
        title="Jobs"
        subtitle={
          data
            ? `${data.pagination.total} ${data.pagination.total === 1 ? "job" : "jobs"}`
            : "Loading jobs"
        }
      />
      <section className="card full data-list-card">
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
          loading={selectionMutationBusy}
          retryLoading={retryFailedJobs.isPending}
          pendingPreparationLoading={runPendingPreparation.isPending}
          onSetDeleted={(deleted) => setSearch({ deleted, page: 1 })}
          onSelectPage={selectPage}
          onSelectAllMatching={selectAllMatching}
          onClearSelection={clearSelection}
          onPrimaryAction={mutatePrimarySelected}
          onHideSelected={hideSelected}
          onPermanentlyDeleteSelected={permanentlyDeleteSelected}
          onRetryFailedSelected={retryFailedSelected}
          onRetryAllFailed={retryAllFailed}
          onRunPendingPreparation={continuePendingPreparation}
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
          columnOrder={savedPresentation.columns.order}
          hiddenColumnIds={savedPresentation.columns.hidden}
          columnWidths={savedPresentation.columns.widths}
          onColumnWidthsChange={handleColumnWidthsChange}
          density={savedPresentation.density}
          grouping={savedPresentation.grouping}
          colorRules={savedPresentation.colorRules}
          toolbarActions={renderSavedTableActions}
        />
      </section>
    </>
  );
}
