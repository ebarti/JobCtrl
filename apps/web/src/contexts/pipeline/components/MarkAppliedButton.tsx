import type { JSX } from "react";

import { useMarkAppliedMutation } from "../hooks/useMarkAppliedMutation.js";

export interface MarkAppliedButtonProps {
  jobId: string;
  className?: string;
  label?: string;
}

export function MarkAppliedButton({
  jobId,
  className = "tab",
  label = "applied",
}: MarkAppliedButtonProps): JSX.Element {
  const markApplied = useMarkAppliedMutation();
  const isPending = markApplied.isPending;
  return (
    <button
      type="button"
      className={className}
      disabled={isPending}
      onClick={() => markApplied.mutate({ jobId })}
    >
      {isPending ? "marking" : label}
    </button>
  );
}
