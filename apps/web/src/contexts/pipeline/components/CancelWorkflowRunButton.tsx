import type { JSX } from "react";

import { useCancelWorkflowRunMutation } from "../hooks/useCancelWorkflowRunMutation.js";

export interface CancelWorkflowRunButtonProps {
  runId: string;
  className?: string;
  label?: string;
  ariaLabel?: string;
}

export function CancelWorkflowRunButton({
  runId,
  className = "tab danger-action",
  label = "stop",
  ariaLabel,
}: CancelWorkflowRunButtonProps): JSX.Element {
  const cancelRun = useCancelWorkflowRunMutation();
  const isPending = cancelRun.isPending;
  return (
    <button
      type="button"
      className={className}
      disabled={isPending}
      aria-label={ariaLabel ?? `Stop workflow run ${runId}`}
      title="Stop workflow run"
      onClick={(event) => {
        event.stopPropagation();
        cancelRun.mutate({ runId });
      }}
    >
      {isPending ? "stopping" : label}
    </button>
  );
}
