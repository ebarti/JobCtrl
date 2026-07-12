import type { JSX } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useMarkAppliedMutation } from "../hooks/useMarkAppliedMutation.js";

export interface MarkAppliedButtonProps {
  jobId: string;
  className?: string;
  label?: string;
}

export function MarkAppliedButton({
  jobId,
  className = "tab",
  label,
}: MarkAppliedButtonProps): JSX.Element {
  const { featureFlags } = usePorts();
  const isDemo = featureFlags.get("demoMode", false);
  const markApplied = useMarkAppliedMutation();
  const isPending = markApplied.isPending;
  const actionLabel = label ?? (isDemo ? "record simulated applied" : "applied");
  return (
    <button
      type="button"
      className={className}
      disabled={isPending}
      onClick={() => markApplied.mutate({ jobId })}
    >
      {isPending ? "marking" : actionLabel}
    </button>
  );
}
