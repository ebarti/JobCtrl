import type { JSX } from "react";
import type { Stage } from "@jobctrl/contracts";

import { Button } from "../../../shared/ui/button.js";
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
  className,
  label = "Stop current stage",
}: CancelStageButtonProps): JSX.Element {
  const cancelStage = useCancelStageMutation();
  const isPending = cancelStage.isPending;
  return (
    <Button
      type="button"
      {...(className ? { className } : {})}
      disabled={isPending}
      aria-label={label}
      title={`Stop the current ${stage} stage for this job.`}
      size="sm"
      variant="warning"
      onClick={() => cancelStage.mutate({ jobId, stage })}
    >
      {isPending ? "Stopping current stage" : label}
    </Button>
  );
}
