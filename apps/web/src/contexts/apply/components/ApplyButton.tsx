import type { JSX } from "react";

import { Button } from "../../../shared/ui/button.js";
import { useApplyJobMutation } from "../hooks/useApplyJobMutation.js";

export interface ApplyButtonProps {
  jobId: string;
  className?: string;
  label?: string;
}

export function ApplyButton({
  jobId,
  className,
  label = "Apply",
}: ApplyButtonProps): JSX.Element {
  const applyJob = useApplyJobMutation();
  const isPending = applyJob.isPending;
  return (
    <Button
      type="button"
      {...(className ? { className } : {})}
      size="sm"
      disabled={isPending}
      onClick={() => applyJob.mutate({ jobId })}
    >
      {isPending ? "Applying" : label}
    </Button>
  );
}
