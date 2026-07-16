import { RefreshAllCompensationButton } from "../../contexts/enrichment/index.js";
import { RetailorCurrentPolicyButton } from "../../contexts/materials/components/RetailorCurrentPolicyButton.js";
import { RescoreCurrentPolicyButton } from "../../contexts/scoring/components/RescoreCurrentPolicyButton.js";
import { ResetStaleScoresButton } from "../../contexts/scoring/components/ResetStaleScoresButton.js";
import type { JobsSearch } from "../../routes/-jobs.search.js";
import { Button } from "../../shared/ui/button.js";
import { Tabs, TabsList, TabsTrigger } from "../../shared/ui/tabs.js";

const JOB_QUEUES = [
  { label: "Active", value: "active" },
  { label: "Deleted", value: "deleted" },
  { label: "Hidden", value: "hidden" },
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
  const legacyClosed = search.deleted === "closed";
  const retryAllFailures = search.deleted === "active";
  const retrySelectedFailures = retryAllFailures && search.state === "failed";
  const primaryLabel = hidden
    ? "unhide selected"
    : restoring
      ? "restore"
      : "delete selected";
  return (
    <>
      <div className="jobs-queue-navigation">
        {legacyClosed ? (
          <span className="jobs-legacy-queue-context" role="status">
            Viewing posting availability exceptions from a legacy link.
          </span>
        ) : null}
        <Tabs
          className="jobs-queue-tabs-root"
          onValueChange={(value) => {
            onSetDeleted(value as JobsSearch["deleted"]);
          }}
          value={legacyClosed ? undefined : search.deleted}
        >
          <TabsList aria-label="Job queues" className="jobs-queue-tabs" loop>
            {JOB_QUEUES.map((queue) => (
              <TabsTrigger key={queue.value} value={queue.value}>
                {queue.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <div className="bulk-bar jobs-bulk-actions">
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
        {!restoring && !hidden && !legacyClosed ? (
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
          <Button
            aria-label="hide selected"
            size="sm"
            type="button"
            variant="outline"
            disabled={!selectedCount || loading}
            onClick={onHideSelected}
          >
            hide
          </Button>
        ) : null}
        {restoring || hidden ? (
          <Button
            aria-label="permanently delete selected"
            size="sm"
            type="button"
            variant="destructive"
            disabled={!selectedCount || loading}
            onClick={onPermanentlyDeleteSelected}
          >
            permanently delete
          </Button>
        ) : null}
        <Button
          aria-label={restoring ? "restore selected" : undefined}
          size="sm"
          type="button"
          variant={restoring || hidden ? "default" : "destructive"}
          disabled={!selectedCount || loading}
          onClick={onPrimaryAction}
        >
          {primaryLabel}
        </Button>
      </div>
    </>
  );
}
