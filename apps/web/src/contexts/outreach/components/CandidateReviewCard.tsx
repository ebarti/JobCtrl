import type { ContactCandidateDto } from "@jobhunter/contracts";
import type { JSX } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { contactRoleLabel, contactSourceKindLabel } from "../lib/contact-copy.js";
import { ConfirmCandidateButton } from "./ConfirmCandidateButton.js";
import { ContactProvenanceList } from "./ContactProvenanceList.js";

export interface CandidateReviewCardProps {
  taskId: string;
  candidate: ContactCandidateDto;
}

function formatConfidence(confidence: number): string {
  if (!Number.isFinite(confidence)) {
    return "unknown";
  }
  return `${Math.round(confidence * 100)}%`;
}

function displayName(candidate: ContactCandidateDto): string {
  return candidate.attributes.find((attribute) => attribute.kind === "name")?.value ?? "Proposed contact";
}

// INV-2: a proposed candidate renders its candidate-level provenance plus the
// full provenance of every attribute. INV-4: the Confirm action is the only path
// to a stored contact fact; a value is never stored until the user confirms.
export function CandidateReviewCard({ taskId, candidate }: CandidateReviewCardProps): JSX.Element {
  const { clipboard } = usePorts();
  const email = candidate.attributes.find((attribute) => attribute.kind === "email")?.value;
  const confirmed = candidate.status === "confirmed";
  return (
    <li className="candidate-review-card">
      <div className="candidate-review-head">
        <span className="job-contact-name">{displayName(candidate)}</span>
        <span className="tag">{contactRoleLabel(candidate.role)}</span>
        <span className="candidate-review-confidence">
          confidence {formatConfidence(candidate.confidence)}
        </span>
        <span className="candidate-review-status">
          {confirmed ? "confirmed" : "needs review"}
        </span>
      </div>
      <dl className="candidate-review-source detail-list" aria-label="Candidate source">
        <div>
          <dt>Found via</dt>
          <dd>{contactSourceKindLabel(candidate.provenance.sourceKind)}</dd>
        </div>
        <div>
          <dt>Reference</dt>
          <dd className="mono">{candidate.provenance.sourceRef}</dd>
        </div>
        <div>
          <dt>Capture method</dt>
          <dd>{candidate.provenance.captureMethod}</dd>
        </div>
      </dl>
      <ContactProvenanceList attributes={candidate.attributes} />
      <div className="candidate-review-actions">
        {email ? (
          <button type="button" className="tab" onClick={() => void clipboard.write(email)}>
            copy email
          </button>
        ) : null}
        {confirmed ? (
          <span className="candidate-confirmed-note">Confirmed into your contacts.</span>
        ) : (
          <ConfirmCandidateButton taskId={taskId} candidateId={candidate.candidateId} />
        )}
      </div>
    </li>
  );
}
