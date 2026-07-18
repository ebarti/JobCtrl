import type { Stage } from "@jobctrl/contracts";
import type { JSX } from "react";

import { Button } from "../../../shared/ui/button.js";
import { useRunJobStageMutation } from "../hooks/useRunJobStageMutation.js";

export interface RunJobStageButtonProps {
  readonly jobId: string;
  readonly stage: Stage;
  readonly className?: string;
  readonly label?: string;
  readonly disabled?: boolean;
}

export function RunJobStageButton({
  jobId,
  stage,
  className,
  label = "Run current stage",
  disabled = false,
}: RunJobStageButtonProps): JSX.Element {
  const mutation = useRunJobStageMutation();
  const blocked = disabled || mutation.isPending;

  return (
    <Button
      aria-label={label}
      {...(className ? { className } : {})}
      variant="outline"
      size="sm"
      disabled={blocked}
      title={`Run the current ${stage} stage for this job.`}
      type="button"
      onClick={() => {
        if (
          blocked ||
          !window.confirm(`Run the current ${stage} stage for this job now?`)
        ) {
          return;
        }
        mutation.mutate({ jobId, stage });
      }}
    >
      {mutation.isPending ? "Starting stage" : label}
    </Button>
  );
}
