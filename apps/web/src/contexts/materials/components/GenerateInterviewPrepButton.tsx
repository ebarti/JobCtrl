import { IconNotebook } from "@tabler/icons-react";
import type { JSX } from "react";

import { Button } from "../../../shared/ui/button.js";
import { useGenerateInterviewPrepMutation } from "../hooks/useGenerateInterviewPrepMutation.js";

export interface GenerateInterviewPrepButtonProps {
  jobId: string;
  className?: string;
  label?: string;
  disabled?: boolean;
  hasAcceptedPrep?: boolean;
}

export function GenerateInterviewPrepButton({
  jobId,
  className = "tab",
  label,
  disabled = false,
  hasAcceptedPrep = false,
}: GenerateInterviewPrepButtonProps): JSX.Element {
  const mutation = useGenerateInterviewPrepMutation();
  const blocked = disabled || mutation.isPending;
  const actionLabel = label ?? (hasAcceptedPrep ? "Regenerate interview prep" : "Generate interview prep");

  return (
    <Button
      aria-label={actionLabel}
      className={className}
      disabled={blocked}
      type="button"
      data-job-id={jobId}
      onClick={() => {
        if (
          blocked ||
          !window.confirm(
            hasAcceptedPrep
              ? "Regenerate interview prep for this job now? The last accepted prep stays visible until a replacement is accepted."
              : "Generate interview prep for this job now? Prep is produced before interviews from stored, grounded JobCtrl data.",
          )
        ) {
          return;
        }
        mutation.mutate({ jobId });
      }}
    >
      <IconNotebook aria-hidden="true" size={14} />
      <span>{mutation.isPending ? "Generating" : actionLabel}</span>
    </Button>
  );
}
