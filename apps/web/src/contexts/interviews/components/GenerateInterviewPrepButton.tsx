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
  const mutation = useGenerateInterviewPrepMutation(jobId);
  const blocked = disabled || mutation.isPending;
  const actionLabel = label ?? (hasAcceptedPrep ? "Regenerate interview prep" : "Generate interview prep");

  return (
    <><Button
      aria-label={actionLabel}
      className={className}
      disabled={blocked || mutation.hasUnconfirmed}
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
    </Button>{mutation.recoveryReady && mutation.hasUnconfirmed ? <div role="alert">
      <p>Previous preparation status: {mutation.observedStatus?.replaceAll("_", " ") ?? "unavailable"}. Check it before starting another.</p>
      <Button type="button" variant="outline" disabled={mutation.checkingStatus} onClick={() => void mutation.checkPrevious()}>Check previous preparation</Button>
      {mutation.hasOriginalInputs ? <Button type="button" variant="outline" disabled={mutation.isPending || !mutation.canRetry} onClick={mutation.retryUnconfirmed}>Retry previous request</Button> : <><p>Inputs were not stored. Open the preparation form to re-enter them, or retry a previous default preparation.</p><Button type="button" variant="outline" disabled={mutation.isPending || !mutation.canResumeWithInputs} onClick={() => mutation.mutate({ jobId })}>Retry previous default preparation</Button></>}
      {mutation.error ? <p role="alert">{mutation.error.message}</p> : null}
      {mutation.recoveryMessage ? <p role="status">{mutation.recoveryMessage}</p> : null}
    </div> : !mutation.recoveryReady ? <p role="alert">{mutation.recoveryError ? "Session recovery storage is unavailable or invalid." : "Checking session recovery storage…"}</p> : null}</>
  );
}
