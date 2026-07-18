import type { JSX } from "react";

import { Button } from "../../../shared/ui/button.js";
import { useCancelWorkflowRunMutation } from "../hooks/useCancelWorkflowRunMutation.js";

export interface CancelWorkflowRunButtonProps {
  runId: string;
  className?: string;
  label?: string;
  ariaLabel?: string;
}

export function CancelWorkflowRunButton({
  runId,
  className,
  label = "Stop",
  ariaLabel,
}: CancelWorkflowRunButtonProps): JSX.Element {
  const cancelRun = useCancelWorkflowRunMutation();
  const isPending = cancelRun.isPending;
  return (
    <Button
      type="button"
      {...(className ? { className } : {})}
      variant="destructive"
      size="sm"
      disabled={isPending}
      aria-label={ariaLabel ?? `Stop workflow run ${runId}`}
      title="Stop workflow run"
      onClick={(event) => {
        event.stopPropagation();
        cancelRun.mutate({ runId });
      }}
    >
      {isPending ? "Stopping" : label}
    </Button>
  );
}
