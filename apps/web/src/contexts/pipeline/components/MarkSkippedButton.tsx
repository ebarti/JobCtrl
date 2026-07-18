import type { JSX } from "react";

import { Button } from "../../../shared/ui/button.js";
import { useMarkSkippedMutation } from "../hooks/useMarkSkippedMutation.js";

export interface MarkSkippedButtonProps {
  jobId: string;
  className?: string;
  label?: string;
}

export function MarkSkippedButton({
  jobId,
  className,
  label = "Skip",
}: MarkSkippedButtonProps): JSX.Element {
  const markSkipped = useMarkSkippedMutation();
  const isPending = markSkipped.isPending;
  return (
    <Button
      type="button"
      {...(className ? { className } : {})}
      variant="ghost"
      size="sm"
      disabled={isPending}
      onClick={() => markSkipped.mutate({ jobId })}
    >
      {isPending ? "Skipping" : label}
    </Button>
  );
}
