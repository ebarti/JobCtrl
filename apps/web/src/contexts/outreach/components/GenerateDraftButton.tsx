import type { OutreachDraftKind } from "@jobctrl/contracts";
import type { JSX } from "react";

import { useGenerateDraftMutation } from "../hooks/useGenerateDraftMutation.js";

export interface GenerateDraftButtonProps {
  contactId: string;
  jobId?: string;
  kind?: OutreachDraftKind;
  label?: string;
}

// Generates a fresh outreach draft (a new generation). The server runs the
// truthfulness gate stack and returns the gated candidate for review; INV-5: the
// last approved draft is retained while a new candidate is drafted.
export function GenerateDraftButton({
  contactId,
  jobId,
  kind,
  label = "generate draft",
}: GenerateDraftButtonProps): JSX.Element {
  const mutation = useGenerateDraftMutation(contactId);
  const errorMessage = mutation.error instanceof Error ? mutation.error.message : "";

  const onGenerate = () => {
    mutation.mutate({
      ...(jobId ? { jobId } : {}),
      ...(kind ? { kind } : {}),
    });
  };

  return (
    <div className="generate-draft">
      <button type="button" className="primary" disabled={mutation.isPending} onClick={onGenerate}>
        {mutation.isPending ? "generating…" : label}
      </button>
      {errorMessage ? (
        <span role="alert" className="banner inline">
          {errorMessage}
        </span>
      ) : null}
    </div>
  );
}
