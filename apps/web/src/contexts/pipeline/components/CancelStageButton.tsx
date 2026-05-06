import type { JSX } from "react";
import type { Stage } from "@jobhunter/contracts";

import { useCancelStageMutation } from "../hooks/useCancelStageMutation.js";

export interface CancelStageButtonProps {
  jobId: string;
  stage: Stage;
  className?: string;
  label?: string;
}

export function CancelStageButton({
  jobId,
  stage,
  className = "tab",
  label = "cancel",
}: CancelStageButtonProps): JSX.Element {
  const cancelStage = useCancelStageMutation();
  const isPending = cancelStage.isPending;
  return (
    <button
      type="button"
      className={className}
      disabled={isPending}
      onClick={() => cancelStage.mutate({ jobId, stage })}
    >
      {isPending ? "cancelling" : label}
    </button>
  );
}
