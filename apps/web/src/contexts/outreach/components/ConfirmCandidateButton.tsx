import type { JSX } from "react";

import { Button } from "../../../shared/ui/button.js";
import { useConfirmCandidateMutation } from "../hooks/useConfirmCandidateMutation.js";

export interface ConfirmCandidateButtonProps {
  taskId: string;
  candidateId: string;
  expectedRevision?: number;
  disabled?: boolean;
}

// INV-4: confirmation is the explicit user command that promotes a proposed
// candidate into a stored Contact fact. Nothing is stored until this is clicked.
export function ConfirmCandidateButton({
  taskId,
  candidateId,
  expectedRevision,
  disabled = false,
}: ConfirmCandidateButtonProps): JSX.Element {
  const mutation = useConfirmCandidateMutation(taskId);
  const errorMessage = mutation.error instanceof Error ? mutation.error.message : "";
  return (
    <div className="confirm-candidate">
      <Button
        type="button"
        disabled={expectedRevision === undefined || disabled || mutation.isPending}
        onClick={() => { if (expectedRevision !== undefined) mutation.mutate({ candidateId, expectedRevision }); }}
      >
        {mutation.isPending ? "Confirming…" : "Confirm contact"}
      </Button>
      {errorMessage ? (
        <span role="alert" className="banner inline">
          {errorMessage}
        </span>
      ) : null}
    </div>
  );
}
