import type { OutreachDraftDto } from "@jobctrl/contracts";
import { useState, type JSX } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { Button } from "../../../shared/ui/button.js";
import { formatApprovedDraftForClipboard } from "../lib/draft-copy.js";

export interface CopyDraftButtonProps {
  draft: OutreachDraftDto;
}

// INV-1: an approved draft leaves JobCtrl ONLY through a user-initiated
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
    <Button type="button" disabled={!approved} variant="outline" onClick={onCopy}>
      {copied ? "Copied" : "Copy approved message"}
    </Button>
  );
}
