import type { JSX } from "react";

import { useDryRunApplyMutation } from "../hooks/useDryRunApplyMutation.js";

export interface DryRunButtonProps {
  jobId: string;
  className?: string;
  label?: string;
}

export function DryRunButton({
  jobId,
  className = "tab",
  label = "dry-run",
}: DryRunButtonProps): JSX.Element {
  const dryRun = useDryRunApplyMutation();
  const isPending = dryRun.isPending;
  return (
    <button
      type="button"
      className={className}
      disabled={isPending}
      onClick={() => dryRun.mutate({ jobId })}
    >
      {isPending ? "running" : label}
    </button>
  );
}
