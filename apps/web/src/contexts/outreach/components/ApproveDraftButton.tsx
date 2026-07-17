import type { JSX } from "react";

import { useApproveDraftMutation } from "../hooks/useApproveDraftMutation.js";

export interface ApproveDraftButtonProps {
  threadId: string;
  contactId: string;
  jobId?: string;
  draftId: string;
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
  disabled = false,
  onActionStart,
  onActionSettled,
}: ApproveDraftButtonProps): JSX.Element {
  const mutation = useApproveDraftMutation(threadId, contactId, jobId);
  const errorMessage = mutation.error instanceof Error ? mutation.error.message : "";

  function onApprove(): void {
    if (disabled || mutation.isPending || (onActionStart && !onActionStart())) {
      return;
    }
    mutation.mutate(
      { draftId },
      {
        onSettled: () => onActionSettled?.(),
      },
    );
  }

  return (
    <div className="approve-draft">
      <button
        type="button"
        className="primary"
        disabled={disabled || mutation.isPending}
        onClick={onApprove}
      >
        {mutation.isPending ? "approving…" : "approve draft"}
      </button>
      {errorMessage ? (
        <span role="alert" className="banner inline">
          {errorMessage}
        </span>
      ) : null}
    </div>
  );
}
