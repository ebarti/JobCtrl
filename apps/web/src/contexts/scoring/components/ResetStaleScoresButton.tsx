import { IconRotateClockwise } from "@tabler/icons-react";
import type { JSX } from "react";

import { Button } from "../../../shared/ui/button.js";
import { useResetStaleScoresForRescoreMutation } from "../hooks/useResetStaleScoresForRescoreMutation.js";

type ResetStaleScoresActionRender = (props: {
  readonly "aria-label": string;
  readonly children: JSX.Element;
  readonly className: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) => JSX.Element;

export interface ResetStaleScoresButtonProps {
  readonly jobKeys?: readonly string[];
  readonly staleCount: number;
  readonly label?: string;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly onSuccess?: () => void;
  /**
   * Renders the action with a caller-owned interactive primitive. This lets a
   * menu own its item semantics while preserving this control's behavior.
   */
  readonly render?: ResetStaleScoresActionRender;
}

export function ResetStaleScoresButton({
  jobKeys = [],
  staleCount,
  label,
  className = "tab",
  disabled = false,
  onSuccess,
  render,
}: ResetStaleScoresButtonProps) {
  const mutation = useResetStaleScoresForRescoreMutation();
  const resetCount = jobKeys.length || staleCount;
  const buttonLabel = label ?? (jobKeys.length ? "Reset stale selected" : "Reset all stale scores");
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
  const buttonContent = (
    <>
      <IconRotateClockwise aria-hidden="true" size={14} />
      <span>{mutation.isPending ? "Resetting stale scores" : buttonLabel}</span>
    </>
  );

  if (render) {
    return render({
      "aria-label": buttonLabel,
      children: buttonContent,
      className,
      disabled: blocked,
      onClick: reset,
    });
  }

  return (
    <Button
      aria-label={buttonLabel}
      className={className}
      disabled={blocked}
      type="button"
      onClick={reset}
    >
      {buttonContent}
    </Button>
  );
}
