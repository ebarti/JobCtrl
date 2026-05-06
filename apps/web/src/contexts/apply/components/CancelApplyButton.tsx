import type { JSX } from "react";

import { useCancelApplyMutation } from "../hooks/useCancelApplyMutation.js";

export interface CancelApplyButtonProps {
  jobId: string;
  runId?: string;
  className?: string;
  label?: string;
}

export function CancelApplyButton({
  jobId,
  runId,
  className = "tab",
  label = "cancel apply",
}: CancelApplyButtonProps): JSX.Element {
  const cancelApply = useCancelApplyMutation();
  const isPending = cancelApply.isPending;
  return (
    <button
      type="button"
      className={className}
      disabled={isPending}
      onClick={() => cancelApply.mutate(runId ? { jobId, runId } : { jobId })}
    >
      {isPending ? "cancelling" : label}
    </button>
  );
}
