import type { JSX } from "react";

import { Button } from "../../../shared/ui/button.js";
import { useApproveDraftMutation } from "../hooks/useApproveDraftMutation.js";

export interface ApproveDraftButtonProps {
  threadId: string;
  contactId: string;
  jobId?: string;
  draftId: string;
  expectedFingerprint?: string;
  disabled?: boolean;
  onActionStart?: () => boolean;
  onActionSettled?: () => void;
}

// Approval is gated on the persisted gate outcome (INV-5): the caller disables
// this when the draft's gates did not pass. The server remains the final authority.
export function ApproveDraftButton({
  threadId,
  contactId,
  jobId,
  draftId,
  expectedFingerprint,
  disabled = false,
  onActionStart,
  onActionSettled,
}: ApproveDraftButtonProps): JSX.Element {
  const mutation = useApproveDraftMutation(threadId, contactId, jobId);
  const errorMessage = mutation.error instanceof Error ? mutation.error.message : "";

  function onApprove(): void {
    if (!expectedFingerprint || disabled || mutation.isPending || (onActionStart && !onActionStart())) {
      return;
    }
    mutation.mutate(
      { draftId, expectedFingerprint },
      {
        onSettled: () => onActionSettled?.(),
      },
    );
  }

  return (
    <div className="approve-draft">
      <Button
        type="button"
        disabled={!expectedFingerprint || disabled || mutation.isPending}
        onClick={onApprove}
      >
        {mutation.isPending ? "Approving…" : "Approve draft"}
      </Button>
      {errorMessage ? (
        <span role="alert" className="banner inline">
          {errorMessage}
        </span>
      ) : null}
    </div>
  );
}
