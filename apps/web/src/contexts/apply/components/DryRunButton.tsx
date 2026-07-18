import type { JSX } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { Button } from "../../../shared/ui/button.js";
import { useDryRunApplyMutation } from "../hooks/useDryRunApplyMutation.js";

export interface DryRunButtonProps {
  jobId: string;
  className?: string;
  label?: string;
}

export function DryRunButton({
  jobId,
  className,
  label,
}: DryRunButtonProps): JSX.Element {
  const { featureFlags } = usePorts();
  const isDemo = featureFlags.get("demoMode", false);
  const dryRun = useDryRunApplyMutation();
  const isPending = dryRun.isPending;
  const actionLabel = label ?? (isDemo ? "Rehearse application" : "Dry run");
  return (
    <Button
      type="button"
      {...(className ? { className } : {})}
      size="sm"
      variant="outline"
      disabled={isPending}
      onClick={() => dryRun.mutate({ jobId })}
    >
      {isPending ? "Running" : actionLabel}
    </Button>
  );
}
