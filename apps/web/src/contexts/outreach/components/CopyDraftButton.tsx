import type { OutreachDraftDto } from "@jobctl/contracts";
import { useState, type JSX } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { formatApprovedDraftForClipboard } from "../lib/draft-copy.js";

export interface CopyDraftButtonProps {
  draft: OutreachDraftDto;
}

// INV-1: an approved draft leaves JobCtl ONLY through a user-initiated
// clipboard copy via the ClipboardPort — never a network send, never
// navigator.clipboard directly. Enabled only for an approved draft.
export function CopyDraftButton({ draft }: CopyDraftButtonProps): JSX.Element {
  const { clipboard } = usePorts();
  const [copied, setCopied] = useState(false);
  const approved = draft.status === "approved";

  const onCopy = () => {
    if (!approved) {
      return;
    }
    void clipboard.write(formatApprovedDraftForClipboard(draft)).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <button type="button" className="tab" disabled={!approved} onClick={onCopy}>
      {copied ? "copied" : "copy approved message"}
    </button>
  );
}
