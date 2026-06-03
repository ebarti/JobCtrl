import type { JSX } from "react";

import { useApplyRunsListQuery } from "../../operations/hooks/useApplyRunsListQuery.js";
import { useCancelApplyMutation } from "../hooks/useCancelApplyMutation.js";

export const ACTIVE_APPLY_RUN_STATUSES = new Set(["starting", "in_progress", "queued", "running"]);

export interface CancelApplyButtonProps {
  jobId: string;
  /** Override the auto-detected active run id. If omitted, the button looks
   *  up the most recently started non-terminal apply run for ``jobId`` and
   *  forwards its runId to the worker — without a runId the cancel is
   *  ignored by the Temporal cut-over and the workflow keeps polling. */
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
}: CancelApplyButtonProps): JSX.Element {
  const cancelApply = useCancelApplyMutation();
  const isPending = cancelApply.isPending;
  // Auto-detect the active run when the caller didn't pass one. Without
  // this, clicking cancel only writes a SQLite event — the running
  // Temporal workflow keeps polling Chrome and the stage row drifts
  // back to running on the next worker_loop cycle.
  const { data: runs } = useApplyRunsListQuery();
  const detectedRunId = runId
    ?? runs?.find(
      (run) => run.jobKey === jobId && ACTIVE_APPLY_RUN_STATUSES.has(run.status),
    )?.runId;
  return (
    <button
      type="button"
      className={className}
      disabled={isPending}
      aria-label={ariaLabel}
      onClick={() =>
        cancelApply.mutate(detectedRunId ? { jobId, runId: detectedRunId } : { jobId })
      }
    >
      {isPending ? "cancelling" : label}
    </button>
  );
}
