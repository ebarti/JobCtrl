import { RefreshAllCompensationButton } from "../../contexts/enrichment/index.js";
import { RetailorCurrentPolicyButton } from "../../contexts/materials/components/RetailorCurrentPolicyButton.js";
import { RescoreCurrentPolicyButton } from "../../contexts/scoring/components/RescoreCurrentPolicyButton.js";
import { ResetStaleScoresButton } from "../../contexts/scoring/components/ResetStaleScoresButton.js";
import type { JobsSearch } from "../../routes/-jobs.search.js";

export interface JobBulkActionsProps {
  search: JobsSearch;
  selectedCount: number;
  selectedJobKeys?: readonly string[];
  staleCount?: number;
  selectedStaleKeys?: readonly string[];
  hasItems: boolean;
  hasAnyMatching: boolean;
  hasLocalFilters?: boolean;
  loading: boolean;
  retryLoading?: boolean;
  pendingPreparationLoading?: boolean;
  onSetDeleted: (deleted: JobsSearch["deleted"]) => void;
  onSelectPage: () => void;
  onSelectAllMatching: () => void;
  onClearSelection: () => void;
  onPrimaryAction: () => void;
  onHideSelected: () => void;
  onPermanentlyDeleteSelected: () => void;
  onRetryFailedSelected?: () => void;
  onRetryAllFailed?: () => void;
  onRunPendingPreparation?: () => void;
  onResetStaleSuccess?: () => void;
  onMaintenanceSuccess?: () => void;
}

export function JobBulkActions({
  search,
  selectedCount,
  selectedJobKeys = [],
  staleCount = 0,
  selectedStaleKeys = [],
  hasItems,
  hasAnyMatching,
  hasLocalFilters = false,
  loading,
  retryLoading = loading,
  pendingPreparationLoading = loading,
  onSetDeleted,
  onSelectPage,
  onSelectAllMatching,
  onClearSelection,
  onPrimaryAction,
  onHideSelected,
  onPermanentlyDeleteSelected,
  onRetryFailedSelected = () => {},
  onRetryAllFailed = () => {},
  onRunPendingPreparation = () => {},
  onResetStaleSuccess = () => {},
  onMaintenanceSuccess = () => {},
}: JobBulkActionsProps) {
  const restoring = search.deleted === "deleted";
  const hidden = search.deleted === "hidden";
  const closed = search.deleted === "closed";
  const retryAllFailures = search.deleted === "active";
  const retrySelectedFailures = retryAllFailures && search.state === "failed";
  const primaryLabel = hidden
    ? "unhide selected"
    : restoring
      ? "restore selected"
      : "delete selected";
  return (
    <div className="bulk-bar">
      <div className="tabs">
        <button
          className={`tab ${search.deleted === "active" ? "on" : ""}`}
          type="button"
          onClick={() => onSetDeleted("active")}
        >
          active jobs
        </button>
        <button
          className={`tab ${closed ? "on" : ""}`}
          type="button"
          onClick={() => onSetDeleted("closed")}
        >
          closed jobs
        </button>
        <button
          className={`tab ${restoring ? "on" : ""}`}
          type="button"
          onClick={() => onSetDeleted("deleted")}
        >
          deleted jobs
        </button>
        <button
          className={`tab ${hidden ? "on" : ""}`}
          type="button"
          onClick={() => onSetDeleted("hidden")}
        >
          hidden jobs
        </button>
      </div>
      <span className="meta">
        {selectedCount ? `${selectedCount} selected` : "select jobs to manage"}
      </span>
      <button
        className="tab"
        type="button"
        disabled={!hasItems}
        onClick={onSelectPage}
      >
        select page
      </button>
      <button
        className="tab"
        type="button"
        disabled={!hasAnyMatching || hasLocalFilters}
        onClick={onSelectAllMatching}
      >
        select all matching
      </button>
      <button
        className="tab"
        type="button"
        disabled={!selectedCount}
        onClick={onClearSelection}
      >
        clear selected
      </button>
      <RefreshAllCompensationButton onSuccess={onMaintenanceSuccess} />
      {staleCount || selectedStaleKeys.length ? (
        <ResetStaleScoresButton
          jobKeys={selectedStaleKeys}
          staleCount={selectedStaleKeys.length || staleCount}
          label={
            selectedStaleKeys.length
              ? "reset stale selected"
              : "reset all stale scores"
          }
          onSuccess={onResetStaleSuccess}
        />
      ) : null}
      {!restoring && !hidden && !closed ? (
        <>
          <RescoreCurrentPolicyButton onSuccess={onMaintenanceSuccess} />
          <RetailorCurrentPolicyButton onSuccess={onMaintenanceSuccess} />
          {selectedJobKeys.length ? (
            <>
              <RescoreCurrentPolicyButton
                jobKeys={selectedJobKeys}
                label="rescore selected"
                onSuccess={onMaintenanceSuccess}
              />
              <RetailorCurrentPolicyButton
                jobKeys={selectedJobKeys}
                label="re-tailor selected"
                onSuccess={onMaintenanceSuccess}
              />
            </>
          ) : null}
        </>
      ) : null}
      {retrySelectedFailures ? (
          <button
            className="tab on"
            type="button"
            disabled={!selectedCount || retryLoading}
            onClick={onRetryFailedSelected}
          >
            retry selected
          </button>
      ) : null}
      {retryAllFailures ? (
        <>
          <button
            className="tab"
            type="button"
            disabled={hasLocalFilters || pendingPreparationLoading}
            onClick={onRunPendingPreparation}
          >
            continue pending prep
          </button>
          <button
            className="tab"
            type="button"
            disabled={hasLocalFilters || retryLoading}
            onClick={onRetryAllFailed}
          >
            retry all failed
          </button>
        </>
      ) : null}
      {!hidden ? (
        <button
          className="tab danger-action"
          type="button"
          disabled={!selectedCount || loading}
          onClick={onHideSelected}
        >
          hide selected
        </button>
      ) : null}
      {restoring || hidden ? (
        <button
          className="tab danger-action"
          type="button"
          disabled={!selectedCount || loading}
          onClick={onPermanentlyDeleteSelected}
        >
          delete permanently selected
        </button>
      ) : null}
      <button
        className={`tab ${restoring || hidden ? "on" : "danger-action"}`}
        type="button"
        disabled={!selectedCount || loading}
        onClick={onPrimaryAction}
      >
        {primaryLabel}
      </button>
    </div>
  );
}
