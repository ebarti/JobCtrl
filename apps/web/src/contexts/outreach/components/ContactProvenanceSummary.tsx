import type { ContactSummary } from "@jobctrl/contracts";
import type { JSX } from "react";

import { contactSourceKindLabel } from "../lib/contact-copy.js";

export interface ContactProvenanceSummaryProps {
  contact: Pick<ContactSummary, "sourceKinds" | "confirmedCount" | "attributeCount" | "allConfirmed">;
}

// INV-2 at the list level: ContactSummary carries the provenance signals the
// list DTO exposes (source kinds + confirmation counts). Full per-fact
// provenance lives on the detail (ContactProvenanceList).
export function ContactProvenanceSummary({ contact }: ContactProvenanceSummaryProps): JSX.Element {
  const confirmedLabel = `${contact.confirmedCount} of ${contact.attributeCount} facts confirmed`;
  const sourcesLabel = contact.sourceKinds.length
    ? contact.sourceKinds.map(contactSourceKindLabel).join(", ")
    : "no recorded facts";
  return (
    <span
      className="contact-provenance-summary"
      aria-label={`Provenance: ${sourcesLabel}; ${confirmedLabel}`}
    >
      {contact.sourceKinds.map((kind) => (
        <span key={kind} className={`tag contact-source-${kind}`}>
          {contactSourceKindLabel(kind)}
        </span>
      ))}
      <span className={`contact-confirmed ${contact.allConfirmed ? "all" : "partial"}`}>
        {confirmedLabel}
      </span>
    </span>
  );
}
