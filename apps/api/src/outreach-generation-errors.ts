import type { OutreachPublicationConflict } from "@jobctrl/contracts";

export class OutreachPublicationConflictError extends Error {
  constructor(readonly conflict: OutreachPublicationConflict) {
    super("Outreach changed while this draft was being verified. Your edits and completed checks are retained. Compare the current thread before deliberately retrying.");
  }
}

/** Safe worker error protocol; never forward source/model/provider prose. */
export class OutreachGenerationError extends Error {
  constructor(readonly code: string) {
    super(
      code === "budget_denied"
        ? "Outreach drafting spend was denied. Review the contact lane budget before retrying."
        : code === "provider_unavailable"
          ? "Outreach drafting provider is unavailable. Configure a ready provider before retrying."
          : code.startsWith("offer_")
            ? "Offer sources or the required decision are missing or changed. Reload the offer, review it and generate a new draft."
            : "Outreach verification could not complete. Retry after resolving the reported failure. The previous approved message remains available.",
    );
  }
}
export function outreachWorkerError(data: unknown): OutreachGenerationError {
  const code =
    typeof data === "string"
      ? /^semantic_determination:([a-z_]+)$/.exec(data)?.[1]
      : null;
  return new OutreachGenerationError(code ?? "outreach_generation_failed");
}
