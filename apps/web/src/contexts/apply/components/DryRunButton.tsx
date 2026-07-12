import type { JSX } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useDryRunApplyMutation } from "../hooks/useDryRunApplyMutation.js";

export interface DryRunButtonProps {
  jobId: string;
  className?: string;
  label?: string;
}

export function DryRunButton({
  jobId,
  className = "tab",
  label,
}: DryRunButtonProps): JSX.Element {
  const { featureFlags } = usePorts();
  const isDemo = featureFlags.get("demoMode", false);
  const dryRun = useDryRunApplyMutation();
  const isPending = dryRun.isPending;
  const actionLabel = label ?? (isDemo ? "rehearse application" : "dry-run");
  return (
    <button
      type="button"
      className={className}
      disabled={isPending}
      onClick={() => dryRun.mutate({ jobId })}
    >
      {isPending ? "running" : actionLabel}
    </button>
  );
}
