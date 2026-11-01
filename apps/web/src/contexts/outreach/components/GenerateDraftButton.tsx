import type { OutreachDraftKind, OutreachPublicationConflict } from "@jobctrl/contracts";
import { useId, useRef, useState, type JSX } from "react";

import {
  getApiCapabilityAvailability,
  LOCAL_INSTALL_GUIDE_URL,
} from "../../../shared/lib/apiCapabilityAvailability.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { Button } from "../../../shared/ui/button.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { readPublicationConflict } from "../lib/publication-conflict.js";
import { RetainedOutreachSessions } from "./RetainedOutreachSessions.js";
import { UnpublishedOutreachProposal } from "./UnpublishedOutreachProposal.js";
import { useGenerateDraftMutation } from "../hooks/useGenerateDraftMutation.js";

export interface GenerateDraftButtonProps {
  contactId: string;
  jobId?: string;
  kind?: OutreachDraftKind;
  offerRevisionId?: string;
  label?: string;
}

// Generates a fresh outreach draft (a new generation). The server runs the
// truthfulness gate stack and returns the gated candidate for review; INV-5: the
// last approved draft is retained while a new candidate is drafted.
export function GenerateDraftButton(props: GenerateDraftButtonProps): JSX.Element {
  const tenantId = useTenantId();
  return (
    <RetainedOutreachSessions key={tenantId} targetKey={JSON.stringify([props.contactId, props.jobId ?? null, props.kind ?? null, props.offerRevisionId ?? null])}>
      <GenerateDraftSession {...props} />
    </RetainedOutreachSessions>
  );
}

function GenerateDraftSession({
  contactId,
  jobId,
  kind,
  offerRevisionId,
  label = "Generate draft",
}: GenerateDraftButtonProps): JSX.Element {
  const { featureFlags } = usePorts();
  const availability = getApiCapabilityAvailability(
    featureFlags,
    "generateOutreachDraft",
  );
  const unavailableReasonId = useId();
  const mutation = useGenerateDraftMutation(contactId);
  const [retainedConflict, setRetainedConflict] = useState<OutreachPublicationConflict | null>(null);
  const [reconciled, setReconciled] = useState(false);
  const dispatching = useRef(false);
  const errorMessage = mutation.error instanceof Error ? mutation.error.message : "";
  const blocked = mutation.isPending || !availability.available || (retainedConflict !== null && !reconciled);

  const onGenerate = async () => {
    if (blocked || dispatching.current) return;
    dispatching.current = true;
    // A failed deliberate retry retains the last completed proposal, but the
    // comparison must be deliberate again before any further model work.
    setReconciled(false);
    try {
      await mutation.mutateAsync({
        ...(jobId ? { jobId } : {}),
        ...(kind ? { kind } : {}),
        ...(offerRevisionId ? { offerRevisionId } : {}),
      });
      setRetainedConflict(null);
    } catch (error) {
      const conflict = readPublicationConflict(error);
      if (conflict) setRetainedConflict(conflict);
    } finally {
      dispatching.current = false;
    }
  };

  return (
    <div className="generate-draft">
      <Button
        aria-describedby={availability.available ? undefined : unavailableReasonId}
        type="button"
        disabled={blocked}
        onClick={() => { void onGenerate(); }}
      >
        {mutation.isPending ? "Generating…" : label}
      </Button>
      {!availability.available ? (
        <span className="meta" id={unavailableReasonId}>
          Draft generation is available in the local app. This public demo does
          not create messages or use personal contact information. {" "}
          <a href={LOCAL_INSTALL_GUIDE_URL}>Install JobCtrl</a>.
        </span>
      ) : null}
      {retainedConflict ? (
        <>
          <UnpublishedOutreachProposal conflict={retainedConflict} mode="generation" reconciled={reconciled} onReconciled={setReconciled} disabled={mutation.isPending} />
          <Button type="button" variant="outline" disabled={mutation.isPending} onClick={() => {
            setRetainedConflict(null);
            setReconciled(false);
            mutation.reset();
          }}>Discard unpublished draft</Button>
        </>
      ) : null}
      {errorMessage ? (
        <span role="alert" className="banner inline">
          {errorMessage}
        </span>
      ) : null}
    </div>
  );
}
