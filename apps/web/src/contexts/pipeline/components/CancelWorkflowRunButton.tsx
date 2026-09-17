import type { JSX } from "react";

import { cn } from "../../../shared/lib/cn.js";
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
  const cancellationAccepted = cancelRun.data?.status === "canceling";
  const alreadyTerminal = cancelRun.data?.status === "already_terminal";
  const responseError =
    cancelRun.isSuccess && !cancellationAccepted && !alreadyTerminal
      ? cancelRun.data.message || `Cancellation failed (${cancelRun.data.status}).`
      : null;
  const buttonLabel = isPending
    ? "Stopping"
    : cancellationAccepted
      ? "Cancellation requested"
      : alreadyTerminal
        ? "Already finished"
        : label;
  return (
    <span className="workflow-cancel-action">
      <Button
        type="button"
        className={cn("border-destructive-text text-destructive-text hover:bg-destructive-muted", className)}
        variant="outline"
        size="sm"
        disabled={isPending || cancellationAccepted || alreadyTerminal}
        aria-label={ariaLabel ?? `Stop workflow run ${runId}`}
        title="Stop workflow run"
        onClick={(event) => {
          event.stopPropagation();
          cancelRun.mutate({ runId });
        }}
      >
        {buttonLabel}
      </Button>
      {cancelRun.isError || responseError ? (
        <small data-typography="metadata" role="alert">
          {cancelRun.isError ? cancelRun.error.message : responseError}
        </small>
      ) : null}
    </span>
  );
}
