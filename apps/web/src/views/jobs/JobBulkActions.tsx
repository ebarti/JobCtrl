import { IconChevronDown } from "@tabler/icons-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../../shared/ui/dropdown-menu.js";
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
    ? "Unhide selected"
    : restoring
      ? "Restore selected"
      : "Delete selected";
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
      <div
        className="bulk-bar jobs-bulk-actions"
        data-selection-active={selectedCount ? "true" : "false"}
        aria-label="Job actions"
        role="group"
      >
        <div
          aria-label="Selection actions"
          className="jobs-action-group jobs-selection-actions"
          role="group"
        >
          {selectedCount ? (
            <span data-typography="metadata">{selectedCount} selected</span>
          ) : null}
          <Button
            disabled={!hasItems}
            size="sm"
            type="button"
            variant="outline"
            onClick={onSelectPage}
          >
            Select page
          </Button>
          <Button
            disabled={!hasAnyMatching || hasLocalFilters}
            size="sm"
            type="button"
            variant="outline"
            onClick={onSelectAllMatching}
          >
            Select all matching
          </Button>
          {selectedCount ? (
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={onClearSelection}
            >
              Clear selection
            </Button>
          ) : null}
        </div>
        {hasUnavailableDemoAutomation ? (
          <span data-typography="body" id={unavailableReasonId} role="status">
            Disabled automation actions require the local app. Browser-local job
            organization remains available.{" "}
            <a href={LOCAL_INSTALL_GUIDE_URL}>Install JobCtrl</a>.
          </span>
        ) : null}
        <div
          aria-label="Job operations"
          className="jobs-action-group jobs-operations-actions"
          role="group"
        >
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button size="sm" type="button" variant="outline" />}
            >
              Job operations
              <IconChevronDown aria-hidden="true" data-icon="inline-end" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" aria-label="Job operations">
              {retrySelectedFailures || retryAllFailures ? (
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Workflow recovery</DropdownMenuLabel>
                  {retryAllFailures ? (
                    <DropdownMenuItem
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
                      Continue pending preparation
                    </DropdownMenuItem>
                  ) : null}
                  {retrySelectedFailures ? (
                    <DropdownMenuItem
                      aria-describedby={
                        retryAvailability.available
                          ? undefined
                          : unavailableReasonId
                      }
                      disabled={
                        !selectedCount ||
                        retryLoading ||
                        !retryAvailability.available
                      }
                      onClick={onRetryFailedSelected}
                    >
                      Retry selected
                    </DropdownMenuItem>
                  ) : null}
                  {retryAllFailures ? (
                    <DropdownMenuItem
                      aria-describedby={
                        retryAvailability.available
                          ? undefined
                          : unavailableReasonId
                      }
                      disabled={
                        hasLocalFilters ||
                        retryLoading ||
                        !retryAvailability.available
                      }
                      onClick={onRetryAllFailed}
                    >
                      Retry all failed
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuGroup>
              ) : null}
              <DropdownMenuGroup>
                <DropdownMenuLabel>Maintenance</DropdownMenuLabel>
                <RefreshAllCompensationButton
                  className=""
                  label="Refresh compensation"
                  render={(props) => <DropdownMenuItem {...props} />}
                  {...(!refreshCompensationAvailability.available
                    ? { ariaDescribedBy: unavailableReasonId }
                    : {})}
                  disabled={!refreshCompensationAvailability.available}
                  onSuccess={onMaintenanceSuccess}
                />
                {staleCount || selectedStaleKeys.length ? (
                  <ResetStaleScoresButton
                    className=""
                    jobKeys={selectedStaleKeys}
                    label={
                      selectedStaleKeys.length
                        ? "Reset stale selected"
                        : "Reset all stale scores"
                    }
                    staleCount={selectedStaleKeys.length || staleCount}
                    render={(props) => <DropdownMenuItem {...props} />}
                    onSuccess={onResetStaleSuccess}
                  />
                ) : null}
              </DropdownMenuGroup>
              {!restoring && !hidden && !legacyClosed ? (
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Preparation</DropdownMenuLabel>
                  <RescoreCurrentPolicyButton
                    className=""
                    label="Rescore outdated scores"
                    render={(props) => <DropdownMenuItem {...props} />}
                    {...(!rescoreAvailability.available
                      ? { ariaDescribedBy: unavailableReasonId }
                      : {})}
                    disabled={!rescoreAvailability.available}
                    onSuccess={onMaintenanceSuccess}
                  />
                  <RetailorCurrentPolicyButton
                    className=""
                    label="Re-tailor outdated materials"
                    render={(props) => <DropdownMenuItem {...props} />}
                    {...(!retailorAvailability.available
                      ? { ariaDescribedBy: unavailableReasonId }
                      : {})}
                    disabled={!retailorAvailability.available}
                    onSuccess={onMaintenanceSuccess}
                  />
                  {selectedJobKeys.length ? (
                    <>
                      <RescoreCurrentPolicyButton
                        className=""
                        jobKeys={selectedJobKeys}
                        label="Rescore selected"
                        render={(props) => <DropdownMenuItem {...props} />}
                        {...(!rescoreAvailability.available
                          ? { ariaDescribedBy: unavailableReasonId }
                          : {})}
                        disabled={!rescoreAvailability.available}
                        onSuccess={onMaintenanceSuccess}
                      />
                      <RetailorCurrentPolicyButton
                        className=""
                        jobKeys={selectedJobKeys}
                        label="Re-tailor selected"
                        render={(props) => <DropdownMenuItem {...props} />}
                        {...(!retailorAvailability.available
                          ? { ariaDescribedBy: unavailableReasonId }
                          : {})}
                        disabled={!retailorAvailability.available}
                        onSuccess={onMaintenanceSuccess}
                      />
                    </>
                  ) : null}
                </DropdownMenuGroup>
              ) : null}
              <DropdownMenuGroup>
                <DropdownMenuLabel>Selection management</DropdownMenuLabel>
                {!hidden ? (
                  <DropdownMenuItem
                    disabled={!selectedCount || loading}
                    onClick={onHideSelected}
                  >
                    Hide selected
                  </DropdownMenuItem>
                ) : null}
                {restoring || hidden ? (
                  <DropdownMenuItem
                    className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                    disabled={!selectedCount || loading}
                    onClick={onPermanentlyDeleteSelected}
                  >
                    Permanently delete selected
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {selectedCount ? (
          <div
            aria-label="Selected job lifecycle actions"
            className="jobs-action-group jobs-lifecycle-actions"
            role="group"
          >
            <Button
              aria-label={restoring ? "Restore selected" : undefined}
              size="sm"
              type="button"
              variant={restoring || hidden ? "default" : "destructive"}
              disabled={loading}
              onClick={onPrimaryAction}
            >
              {primaryLabel}
            </Button>
          </div>
        ) : null}
      </div>
    </>
  );
}
