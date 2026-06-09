import { WandSparkles } from "lucide-react";
import type { JSX } from "react";

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
  label = "generate materials",
  disabled = false,
}: GenerateMaterialsButtonProps): JSX.Element {
  const mutation = useGenerateMaterialsMutation();
  const blocked = disabled || mutation.isPending;

  return (
    <button
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
      <WandSparkles aria-hidden="true" size={14} />
      <span>{mutation.isPending ? "generating" : label}</span>
    </button>
  );
}
