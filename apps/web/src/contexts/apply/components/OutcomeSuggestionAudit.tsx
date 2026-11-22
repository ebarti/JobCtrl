import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { outcomesKeys } from "../outcomes.js";

interface AuditEntry {
  readonly inputStorage: "persisted" | "verified_reconstruction";
  readonly request: Record<string, unknown>;
  readonly receipt: { readonly receipt_id: string; readonly operation: string; readonly input_fingerprint: string; readonly [key: string]: unknown };
}
interface SuggestionAudit {
  readonly ok: true;
  readonly suggestionId: string;
  readonly jobId: string;
  readonly evidenceId: string;
  readonly link: AuditEntry;
  readonly classification: AuditEntry;
}

/** This private evidence is loaded only after the user explicitly opens it. */
export function OutcomeSuggestionAudit({ suggestionId, jobId, evidenceId, expectedReceiptId, expectedFingerprint }: {
  suggestionId: string; jobId: string; evidenceId: string; expectedReceiptId: string; expectedFingerprint: string;
}) {
  const [open, setOpen] = useState(false);
  const tenantId = useTenantId();
  const { http } = usePorts();
  const query = useQuery({
    queryKey: [...outcomesKeys.suggestionAudit(tenantId, suggestionId, expectedReceiptId), jobId, evidenceId, expectedFingerprint],
    enabled: open,
    queryFn: async () => {
      const response = await http.json<SuggestionAudit>("GET", `/v1/outcomes/suggestions/${encodeURIComponent(suggestionId)}/audit`);
      if (response?.ok !== true || response.suggestionId !== suggestionId || response.jobId !== jobId || response.evidenceId !== evidenceId ||
          response.classification?.receipt?.receipt_id !== expectedReceiptId || response.classification.receipt.input_fingerprint !== expectedFingerprint ||
          response.classification.receipt.operation !== "applications.message_outcome" || response.link?.receipt?.operation !== "applications.message_link" ||
          !["persisted", "verified_reconstruction"].includes(response.classification.inputStorage) ||
          !["persisted", "verified_reconstruction"].includes(response.link.inputStorage)) {
        throw new Error("The audit records do not match this suggestion and its saved source identity.");
      }
      return response;
    },
  });
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Inspect the source and model requests</summary>
    <p>This audit includes the original private message and recorded model inputs.</p>
    {query.isFetching ? <p role="status">Loading source-bound audit.</p> : null}
    {query.error ? <p role="alert">The source-bound audit is unavailable: {query.error.message}</p> : null}
    {query.data ? <>
      {([ ["Message link", query.data.link], ["Outcome classification", query.data.classification] ] as const).map(([label, entry]) => <section key={label}>
        <h5>{label}</h5>
        <p>{entry.inputStorage === "persisted" ? "Original request retained" : "Request reconstructed and verified against the saved fingerprint"}</p>
        <pre className="whitespace-pre-wrap break-words">{JSON.stringify(entry, null, 2)}</pre>
      </section>)}
    </> : null}
  </details>;
}
