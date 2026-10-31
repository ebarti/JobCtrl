import type { JSX } from "react";
import type { Stage } from "@jobctrl/contracts";

import { getApiCapabilityAvailability } from "../../../shared/lib/apiCapabilityAvailability.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { Button } from "../../../shared/ui/button.js";
import { useRetryStageMutation } from "../hooks/useRetryStageMutation.js";

export interface RetryStageButtonProps {
  jobId: string;
  detailQueryId?: string;
  stage: Stage;
  resetAttempts?: boolean;
  runAfter?: boolean;
  dryRun?: boolean;
  refreshApplyUrl?: boolean;
  className?: string;
  label?: string;
}

export function RetryStageButton({
  jobId,
  detailQueryId,
  stage,
  resetAttempts = false,
  runAfter = false,
  dryRun = false,
  refreshApplyUrl = false,
  className,
  label = "Retry",
}: RetryStageButtonProps): JSX.Element {
  const { featureFlags } = usePorts();
  const availability = getApiCapabilityAvailability(featureFlags, "retryStage");
  const retryStage = useRetryStageMutation();
  const isPending = retryStage.isPending;
  return (
    <Button
      type="button"
      {...(className ? { className } : {})}
      size="sm"
      disabled={isPending || !availability.available}
      title={availability.available ? undefined : availability.reason ?? undefined}
      onClick={() => {
        if (!availability.available) return;
        retryStage.mutate({ jobId, stage, resetAttempts, runAfter, dryRun, refreshApplyUrl,
          ...(detailQueryId === undefined ? {} : { detailQueryId }) });
      }}
    >
      {isPending ? (refreshApplyUrl ? "Refreshing" : "Retrying") : label}
    </Button>
  );
}
