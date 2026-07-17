import { useId } from "react";

import { RefreshAllCompensationButton } from "../../contexts/enrichment/index.js";
import { RetailorCurrentPolicyButton } from "../../contexts/materials/components/RetailorCurrentPolicyButton.js";
import { RescoreCurrentPolicyButton } from "../../contexts/scoring/components/RescoreCurrentPolicyButton.js";
import { ResetStaleScoresButton } from "../../contexts/scoring/components/ResetStaleScoresButton.js";
import type { JobsSearch } from "../../routes/-jobs.search.js";
import {
  getApiCapabilityAvailability,
  LOCAL_INSTALL_GUIDE_URL,
} from "../../shared/lib/apiCapabilityAvailability.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
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
  const { featureFlags } = usePorts();
  const refreshCompensationAvailability = getApiCapabilityAvailability(
    featureFlags,
    "refreshAllCompensation",
  );
  const rescoreAvailability = getApiCapabilityAvailability(
    featureFlags,
    "rescoreJobsNotOnCurrentScoringPolicy",
  );
  const retailorAvailability = getApiCapabilityAvailability(
    featureFlags,
    "retailorCurrentPolicy",
  );
  const retryAvailability = getApiCapabilityAvailability(
    featureFlags,
    "retryFailedJobs",
  );
  const pendingPreparationAvailability = getApiCapabilityAvailability(
    featureFlags,
    "runPendingPreparation",
  );
  const unavailableReasonId = useId();
  const hasUnavailableDemoAutomation = [
    refreshCompensationAvailability,
    rescoreAvailability,
    retailorAvailability,
    retryAvailability,
    pendingPreparationAvailability,
  ].some((availability) => availability.isDemo && !availability.available);
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
        {hasUnavailableDemoAutomation ? (
          <span className="meta" id={unavailableReasonId} role="status">
            Disabled automation actions require the local app. Browser-local job
            organization remains available. {" "}
            <a href={LOCAL_INSTALL_GUIDE_URL}>Install JobCtrl</a>.
          </span>
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
        <RefreshAllCompensationButton
          {...(!refreshCompensationAvailability.available
            ? { ariaDescribedBy: unavailableReasonId }
            : {})}
          disabled={!refreshCompensationAvailability.available}
          onSuccess={onMaintenanceSuccess}
        />
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
            <RescoreCurrentPolicyButton
              {...(!rescoreAvailability.available
                ? { ariaDescribedBy: unavailableReasonId }
                : {})}
              disabled={!rescoreAvailability.available}
              onSuccess={onMaintenanceSuccess}
            />
            <RetailorCurrentPolicyButton
              {...(!retailorAvailability.available
                ? { ariaDescribedBy: unavailableReasonId }
                : {})}
              disabled={!retailorAvailability.available}
              onSuccess={onMaintenanceSuccess}
            />
            {selectedJobKeys.length ? (
              <>
                <RescoreCurrentPolicyButton
                  jobKeys={selectedJobKeys}
                  label="rescore selected"
                  {...(!rescoreAvailability.available
                    ? { ariaDescribedBy: unavailableReasonId }
                    : {})}
                  disabled={!rescoreAvailability.available}
                  onSuccess={onMaintenanceSuccess}
                />
                <RetailorCurrentPolicyButton
                  jobKeys={selectedJobKeys}
                  label="re-tailor selected"
                  {...(!retailorAvailability.available
                    ? { ariaDescribedBy: unavailableReasonId }
                    : {})}
                  disabled={!retailorAvailability.available}
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
            aria-describedby={
              retryAvailability.available ? undefined : unavailableReasonId
            }
            disabled={
              !selectedCount || retryLoading || !retryAvailability.available
            }
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
              aria-describedby={
                pendingPreparationAvailability.available
                  ? undefined
                  : unavailableReasonId
              }
              disabled={
                hasLocalFilters ||
                pendingPreparationLoading ||
                !pendingPreparationAvailability.available
              }
              onClick={onRunPendingPreparation}
            >
              continue pending prep
            </button>
            <button
              className="tab"
              type="button"
              aria-describedby={
                retryAvailability.available ? undefined : unavailableReasonId
              }
              disabled={
                hasLocalFilters || retryLoading || !retryAvailability.available
              }
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
