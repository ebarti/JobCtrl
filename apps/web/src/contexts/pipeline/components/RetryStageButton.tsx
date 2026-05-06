import type { JSX } from "react";
import type { Stage } from "@jobhunter/contracts";

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
  className = "tab on",
  label = "retry",
}: RetryStageButtonProps): JSX.Element {
  const retryStage = useRetryStageMutation();
  const isPending = retryStage.isPending;
  return (
    <button
      type="button"
      className={className}
      disabled={isPending}
      onClick={() => retryStage.mutate({ jobId, stage, resetAttempts, runAfter, dryRun })}
    >
      {isPending ? "retrying" : label}
    </button>
  );
}
