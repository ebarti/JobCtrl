import { RotateCcw } from "lucide-react";

import { useResetStaleScoresForRescoreMutation } from "../hooks/useResetStaleScoresForRescoreMutation.js";

export interface ResetStaleScoresButtonProps {
  readonly jobKeys?: readonly string[];
  readonly staleCount: number;
  readonly label?: string;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly onSuccess?: () => void;
}

export function ResetStaleScoresButton({
  jobKeys = [],
  staleCount,
  label,
  className = "tab",
  disabled = false,
  onSuccess,
}: ResetStaleScoresButtonProps) {
  const mutation = useResetStaleScoresForRescoreMutation();
  const resetCount = jobKeys.length || staleCount;
  const buttonLabel = label ?? (jobKeys.length ? "reset stale selected" : "reset all stale scores");
  const blocked = disabled || mutation.isPending || resetCount <= 0;

  const reset = () => {
    if (blocked) {
      return;
    }
    const scope = jobKeys.length
      ? `${resetCount} stale ${resetCount === 1 ? "score" : "scores"}`
      : "all stale scores";
    if (!window.confirm(`Reset ${scope} for rescore?`)) {
      return;
    }
    const options = onSuccess ? { onSuccess } : undefined;
    mutation.mutate({ jobKeys }, options);
  };

  return (
    <button
      aria-label={buttonLabel}
      className={className}
      disabled={blocked}
      type="button"
      onClick={reset}
    >
      <RotateCcw aria-hidden="true" size={14} />
      <span>{mutation.isPending ? "resetting stale scores" : buttonLabel}</span>
    </button>
  );
}
