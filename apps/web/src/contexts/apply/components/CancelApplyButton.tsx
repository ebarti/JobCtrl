import type { JSX } from "react";

import { useApplyRunsListQuery } from "../../operations/hooks/useApplyRunsListQuery.js";
import { useCancelApplyMutation } from "../hooks/useCancelApplyMutation.js";

export const ACTIVE_APPLY_RUN_STATUSES = new Set(["starting", "in_progress", "queued", "running"]);

export interface CancelApplyButtonProps {
  jobId: string;
  /**
   * The authoritative active run from the job-detail projection. When this is
   * absent, generic action panels retain the bounded dashboard fallback.
   */
  runId?: string;
  className?: string;
  label?: string;
  ariaLabel?: string;
}

export function CancelApplyButton({
  jobId,
  runId,
  className = "tab",
  label = "cancel apply",
  ariaLabel,
}: CancelApplyButtonProps): JSX.Element | null {
  const cancelApply = useCancelApplyMutation();
  const isPending = cancelApply.isPending;
  // A job-detail caller has an exact target from its uncapped, job-scoped
  // read-model query. Preserve the dashboard lookup only for callers that do
  // not have that authority yet.
  const { data: runs } = useApplyRunsListQuery({ enabled: runId === undefined });
  const detectedRunId = runId
    ?? runs?.find(
      (run) => run.jobKey === jobId && ACTIVE_APPLY_RUN_STATUSES.has(run.status),
    )?.runId;
  if (!detectedRunId) {
    return null;
  }

  return (
    <button
      type="button"
      className={className}
      disabled={isPending}
      aria-label={ariaLabel}
      onClick={() => cancelApply.mutate({ jobId, runId: detectedRunId })}
    >
      {isPending ? "cancelling" : label}
    </button>
  );
}
