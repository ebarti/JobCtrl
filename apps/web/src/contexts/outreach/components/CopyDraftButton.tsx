import type { OutreachDraftDto } from "@jobctrl/contracts";
import { useState, type JSX } from "react";

import { useCopyOfferDraft } from "../hooks/useCopyOfferDraft.js";
import { Button } from "../../../shared/ui/button.js";

export interface CopyDraftButtonProps {
  draft: OutreachDraftDto;
  contactId?: string;
  jobId?: string;
}

// INV-1: an approved draft leaves JobCtrl ONLY through a user-initiated
// clipboard copy via the ClipboardPort — never a network send, never
// navigator.clipboard directly. Enabled only for an approved draft.
export function CopyDraftButton({ draft, contactId, jobId }: CopyDraftButtonProps): JSX.Element {
  const copy = useCopyOfferDraft();
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const approved = draft.status === "approved" && draft.offerSourcesCurrent !== false;

  const onCopy = () => {
    if (!approved) {
      return;
    }
    setError("");
    void copy(draft, contactId, jobId).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not copy this draft."));
  };

  return (
    <><Button type="button" disabled={!approved} variant="outline" onClick={onCopy}>
      {copied ? "Copied" : "Copy approved message"}
    </Button>{error ? <span role="alert">{error}</span> : null}</>
  );
}
