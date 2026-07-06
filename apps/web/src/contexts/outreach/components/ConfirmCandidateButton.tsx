import type { JSX } from "react";

import { useConfirmCandidateMutation } from "../hooks/useConfirmCandidateMutation.js";

export interface ConfirmCandidateButtonProps {
  taskId: string;
  candidateId: string;
  disabled?: boolean;
}

// INV-4: confirmation is the explicit user command that promotes a proposed
// candidate into a stored Contact fact. Nothing is stored until this is clicked.
export function ConfirmCandidateButton({
  taskId,
  candidateId,
  disabled = false,
}: ConfirmCandidateButtonProps): JSX.Element {
  const mutation = useConfirmCandidateMutation(taskId);
  const errorMessage = mutation.error instanceof Error ? mutation.error.message : "";
  return (
    <div className="confirm-candidate">
      <button
        type="button"
        className="primary"
        disabled={disabled || mutation.isPending}
        onClick={() => mutation.mutate({ candidateId })}
      >
        {mutation.isPending ? "confirming…" : "confirm contact"}
      </button>
      {errorMessage ? (
        <span role="alert" className="banner inline">
          {errorMessage}
        </span>
      ) : null}
    </div>
  );
}
