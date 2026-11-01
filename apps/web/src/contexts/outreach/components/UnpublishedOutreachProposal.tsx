import type { OutreachPublicationConflict } from "@jobctrl/contracts";
import type { JSX } from "react";

export function UnpublishedOutreachProposal({
  conflict, mode, reconciled, onReconciled, disabled = false,
}: {
  conflict: OutreachPublicationConflict;
  mode: "revision" | "generation";
  reconciled: boolean;
  onReconciled: (checked: boolean) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <div role="group" aria-label={mode === "revision" ? "Unpublished revision" : "Unpublished draft"}>
      <p role="status">This {mode === "revision" ? "revision" : "draft"} was not published because Outreach changed. Your {mode === "revision" ? "edits" : "completed message"} and completed checks are retained. Compare the current accepted message, reviews, sends and reminder before retrying.</p>
      <details>
        <summary>Unpublished message and completed verification</summary>
        <pre className="whitespace-pre-wrap break-words">{conflict.unpublishedDraft.bodyText}</pre>
        <pre className="whitespace-pre-wrap break-words">{JSON.stringify(conflict.unpublishedDraft.gateResults, null, 2)}</pre>
        <pre className="whitespace-pre-wrap break-words">{JSON.stringify(conflict.unpublishedDraft.provenance, null, 2)}</pre>
      </details>
      <label>
        <input type="checkbox" checked={reconciled} disabled={disabled} onChange={(event) => onReconciled(event.target.checked)} />
        I compared the current thread and want to {mode === "revision" ? "verify this edit again" : "generate again"}
      </label>
    </div>
  );
}
