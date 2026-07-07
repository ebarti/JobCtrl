import type { ContactAttributeDto } from "@jobctrl/contracts";
import type { JSX } from "react";

import { formatDateTime } from "../../../shared/lib/formatters.js";
import { Empty } from "../../../shared/ui/empty.js";
import { contactAttributeKindLabel, contactSourceKindLabel } from "../lib/contact-copy.js";

export interface ContactProvenanceListProps {
  attributes: readonly ContactAttributeDto[];
}

function formatConfidence(confidence: number): string {
  if (!Number.isFinite(confidence)) {
    return "unknown";
  }
  return `${Math.round(confidence * 100)}%`;
}

// INV-2: every stored fact renders its full, inspectable provenance —
// sourceKind, sourceRef, captureMethod, capturedAt, confidence, userConfirmed.
export function ContactProvenanceList({ attributes }: ContactProvenanceListProps): JSX.Element {
  if (attributes.length === 0) {
    return <Empty title="No facts recorded for this contact yet." />;
  }
  return (
    <ul className="contact-provenance-list">
      {attributes.map((attribute) => {
        const provenance = attribute.provenance;
        const kindLabel = contactAttributeKindLabel(attribute.kind);
        return (
          <li key={attribute.attributeId} className="contact-provenance-item">
            <div className="contact-provenance-fact">
              <span className="contact-attribute-kind">{kindLabel}</span>
              <span className="contact-attribute-value">{attribute.value}</span>
            </div>
            <dl
              className="contact-provenance-detail detail-list"
              aria-label={`Provenance for ${kindLabel}`}
            >
              <div>
                <dt>Source</dt>
                <dd>{contactSourceKindLabel(provenance.sourceKind)}</dd>
              </div>
              <div>
                <dt>Reference</dt>
                <dd className="mono">{provenance.sourceRef}</dd>
              </div>
              <div>
                <dt>Capture method</dt>
                <dd>{provenance.captureMethod}</dd>
              </div>
              <div>
                <dt>Captured</dt>
                <dd>{formatDateTime(provenance.capturedAt)}</dd>
              </div>
              <div>
                <dt>Confidence</dt>
                <dd>{formatConfidence(provenance.confidence)}</dd>
              </div>
              <div>
                <dt>Confirmation</dt>
                <dd>{provenance.userConfirmed ? "Confirmed by you" : "Not yet confirmed"}</dd>
              </div>
            </dl>
          </li>
        );
      })}
    </ul>
  );
}
