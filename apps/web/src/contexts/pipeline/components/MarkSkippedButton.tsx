import type { JSX } from "react";

import { useMarkSkippedMutation } from "../hooks/useMarkSkippedMutation.js";

export interface MarkSkippedButtonProps {
  jobId: string;
  className?: string;
  label?: string;
}

export function MarkSkippedButton({
  jobId,
  className = "tab",
  label = "skip",
}: MarkSkippedButtonProps): JSX.Element {
  const markSkipped = useMarkSkippedMutation();
  const isPending = markSkipped.isPending;
  return (
    <button
      type="button"
      className={className}
      disabled={isPending}
      onClick={() => markSkipped.mutate({ jobId })}
    >
      {isPending ? "skipping" : label}
    </button>
  );
}
