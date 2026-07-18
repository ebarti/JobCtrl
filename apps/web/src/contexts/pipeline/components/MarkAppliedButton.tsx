import type { JSX } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { Button } from "../../../shared/ui/button.js";
import { useMarkAppliedMutation } from "../hooks/useMarkAppliedMutation.js";

export interface MarkAppliedButtonProps {
  jobId: string;
  className?: string;
  label?: string;
}

export function MarkAppliedButton({
  jobId,
  className,
  label,
}: MarkAppliedButtonProps): JSX.Element {
  const { featureFlags } = usePorts();
  const isDemo = featureFlags.get("demoMode", false);
  const markApplied = useMarkAppliedMutation();
  const isPending = markApplied.isPending;
  const actionLabel = label ?? (isDemo ? "Record simulated application" : "Mark as applied");
  return (
    <Button
      type="button"
      {...(className ? { className } : {})}
      disabled={isPending}
      size="sm"
      variant="success"
      onClick={() => markApplied.mutate({ jobId })}
    >
      {isPending ? "Marking as applied" : actionLabel}
    </Button>
  );
}
