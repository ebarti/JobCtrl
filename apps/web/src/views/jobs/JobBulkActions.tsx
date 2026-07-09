import { RefreshAllCompensationButton } from "../../contexts/enrichment/index.js";
import { RetailorCurrentPolicyButton } from "../../contexts/materials/components/RetailorCurrentPolicyButton.js";
import { RescoreCurrentPolicyButton } from "../../contexts/scoring/components/RescoreCurrentPolicyButton.js";
import { ResetStaleScoresButton } from "../../contexts/scoring/components/ResetStaleScoresButton.js";
import type { JobsSearch } from "../../routes/-jobs.search.js";
import { ToggleGroup, ToggleGroupItem } from "../../shared/ui/toggle-group.js";

const JOB_VIEWS = [
  { label: "active", value: "active" },
  { label: "closed", value: "closed" },
  { label: "deleted", value: "deleted" },
  { label: "hidden", value: "hidden" },
] as const satisfies readonly {
  label: string;
  value: JobsSearch["deleted"];
}[];

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
      ? "restore"
      : "delete selected";
  return (
    <div className="bulk-bar">
      <ToggleGroup
        aria-label="Job views"
        className="job-view-switcher max-w-full flex-wrap"
        size="sm"
        spacing={1}
        type="single"
        value={search.deleted}
        variant="outline"
        onValueChange={(value) => {
          if (value) {
            onSetDeleted(value as JobsSearch["deleted"]);
          }
        }}
      >
        {JOB_VIEWS.map((view) => (
          <ToggleGroupItem key={view.value} value={view.value}>
            {view.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {selectedCount ? (
        <span className="meta">{selectedCount} selected</span>
      ) : null}
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
          aria-label="hide selected"
          className="tab danger-action"
          type="button"
          disabled={!selectedCount || loading}
          onClick={onHideSelected}
        >
          hide
        </button>
      ) : null}
      {restoring || hidden ? (
        <button
          aria-label="permanently delete selected"
          className="tab danger-action"
          type="button"
          disabled={!selectedCount || loading}
          onClick={onPermanentlyDeleteSelected}
        >
          permanently delete
        </button>
      ) : null}
      <button
        aria-label={restoring ? "restore selected" : undefined}
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
