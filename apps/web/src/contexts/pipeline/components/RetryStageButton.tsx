import type { JSX } from "react";
import type { Stage } from "@jobctrl/contracts";

import { Button } from "../../../shared/ui/button.js";
import { useRetryStageMutation } from "../hooks/useRetryStageMutation.js";

export interface RetryStageButtonProps {
  jobId: string;
  stage: Stage;
  resetAttempts?: boolean;
  runAfter?: boolean;
  dryRun?: boolean;
  className?: string;
  label?: string;
}

export function RetryStageButton({
  jobId,
  stage,
  resetAttempts = false,
  runAfter = false,
  dryRun = false,
  className,
  label = "Retry",
}: RetryStageButtonProps): JSX.Element {
  const retryStage = useRetryStageMutation();
  const isPending = retryStage.isPending;
  return (
    <Button
      type="button"
      {...(className ? { className } : {})}
      size="sm"
      disabled={isPending}
      onClick={() => retryStage.mutate({ jobId, stage, resetAttempts, runAfter, dryRun })}
    >
      {isPending ? "Retrying" : label}
    </Button>
  );
}
