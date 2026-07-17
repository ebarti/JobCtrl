import type { OutreachDraftKind } from "@jobctrl/contracts";
import { useId, type JSX } from "react";

import {
  getApiCapabilityAvailability,
  LOCAL_INSTALL_GUIDE_URL,
} from "../../../shared/lib/apiCapabilityAvailability.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
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
  const { featureFlags } = usePorts();
  const availability = getApiCapabilityAvailability(
    featureFlags,
    "generateOutreachDraft",
  );
  const unavailableReasonId = useId();
  const mutation = useGenerateDraftMutation(contactId);
  const errorMessage = mutation.error instanceof Error ? mutation.error.message : "";
  const blocked = mutation.isPending || !availability.available;

  const onGenerate = () => {
    if (blocked) {
      return;
    }
    mutation.mutate({
      ...(jobId ? { jobId } : {}),
      ...(kind ? { kind } : {}),
    });
  };

  return (
    <div className="generate-draft">
      <button
        aria-describedby={availability.available ? undefined : unavailableReasonId}
        type="button"
        className="primary"
        disabled={blocked}
        onClick={onGenerate}
      >
        {mutation.isPending ? "generating…" : label}
      </button>
      {!availability.available ? (
        <span className="meta" id={unavailableReasonId}>
          Draft generation is available in the local app. This public demo does
          not create messages or use personal contact information. {" "}
          <a href={LOCAL_INSTALL_GUIDE_URL}>Install JobCtrl</a>.
        </span>
      ) : null}
      {errorMessage ? (
        <span role="alert" className="banner inline">
          {errorMessage}
        </span>
      ) : null}
    </div>
  );
}
