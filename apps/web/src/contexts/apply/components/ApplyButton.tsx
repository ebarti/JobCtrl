import type { JSX } from "react";

import { useApplyJobMutation } from "../hooks/useApplyJobMutation.js";

export interface ApplyButtonProps {
  jobId: string;
  className?: string;
  label?: string;
}

export function ApplyButton({
  jobId,
  className = "tab on",
  label = "apply",
}: ApplyButtonProps): JSX.Element {
  const applyJob = useApplyJobMutation();
  const isPending = applyJob.isPending;
  return (
    <button
      type="button"
      className={className}
      disabled={isPending}
      onClick={() => applyJob.mutate({ jobId })}
    >
      {isPending ? "applying" : label}
    </button>
  );
}
