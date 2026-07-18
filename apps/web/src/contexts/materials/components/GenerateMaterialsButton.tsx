import { IconSparkles } from "@tabler/icons-react";
import { useId, type JSX } from "react";

import {
  getApiCapabilityAvailability,
  LOCAL_INSTALL_GUIDE_URL,
} from "../../../shared/lib/apiCapabilityAvailability.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { Button } from "../../../shared/ui/button.js";
import { useGenerateMaterialsMutation } from "../hooks/useGenerateMaterialsMutation.js";

export interface GenerateMaterialsButtonProps {
  jobId: string;
  className?: string;
  label?: string;
  disabled?: boolean;
}

// INSPECT-01: per-job material generation is wired (route + mutation hook). The
// click confirms, then dispatches the canonical tailor → cover material stages.
// The async (202) result arrives via the SSE invalidation router; the mutation's
// optimistic queued patch carries the in-flight state until then.
export function GenerateMaterialsButton({
  jobId,
  className = "tab",
  label = "Generate materials",
  disabled = false,
}: GenerateMaterialsButtonProps): JSX.Element {
  const { featureFlags } = usePorts();
  const availability = getApiCapabilityAvailability(
    featureFlags,
    "generateMaterials",
  );
  const unavailableReasonId = useId();
  const mutation = useGenerateMaterialsMutation();
  const blocked = disabled || mutation.isPending || !availability.available;

  return (
    <>
      <Button
        aria-describedby={
          availability.available ? undefined : unavailableReasonId
        }
        aria-label={label}
        className={className}
        disabled={blocked}
        type="button"
        data-job-id={jobId}
        onClick={() => {
          if (
            blocked ||
            !window.confirm(
              "Generate materials for this job now? Existing accepted materials are retained until a replacement is approved.",
            )
          ) {
            return;
          }
          mutation.mutate({ jobId });
        }}
      >
        <IconSparkles aria-hidden="true" size={14} />
        <span>{mutation.isPending ? "Generating" : label}</span>
      </Button>
      {!availability.available ? (
        <span className="meta" id={unavailableReasonId}>
          Material generation is available in the local app. Existing bundled
          materials remain available to review. {" "}
          <a href={LOCAL_INSTALL_GUIDE_URL}>Install JobCtrl</a>.
        </span>
      ) : null}
    </>
  );
}
