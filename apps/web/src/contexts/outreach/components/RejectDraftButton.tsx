import type { JSX } from "react";

import { useRejectDraftMutation } from "../hooks/useRejectDraftMutation.js";

export interface RejectDraftButtonProps {
  threadId: string;
  contactId: string;
  jobId?: string;
  draftId: string;
  disabled?: boolean;
}

// Rejecting a candidate never touches the last approved draft (INV-5).
export function RejectDraftButton({
  threadId,
  contactId,
  jobId,
  draftId,
  disabled = false,
}: RejectDraftButtonProps): JSX.Element {
  const mutation = useRejectDraftMutation(threadId, contactId, jobId);
  const errorMessage = mutation.error instanceof Error ? mutation.error.message : "";
  return (
    <div className="reject-draft">
      <button
        type="button"
        className="tab"
        disabled={disabled || mutation.isPending}
        onClick={() => mutation.mutate({ draftId })}
      >
        {mutation.isPending ? "rejecting…" : "reject draft"}
      </button>
      {errorMessage ? (
        <span role="alert" className="banner inline">
          {errorMessage}
        </span>
      ) : null}
    </div>
  );
}
