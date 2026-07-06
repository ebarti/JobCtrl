import type { OutreachClaimProvenanceDto } from "@jobhunter/contracts";
import type { JSX } from "react";

import { Empty } from "../../../shared/ui/empty.js";

export interface DraftClaimProvenanceListProps {
  provenance: readonly OutreachClaimProvenanceDto[];
}

// INV-2: every draft renders its claim -> fact provenance. Each claim shows the
// generated text, the confirmed contact-fact ids it rests on, whether it is
// grounded in the user's profile, and the rationale binding claim to evidence.
export function DraftClaimProvenanceList({
  provenance,
}: DraftClaimProvenanceListProps): JSX.Element {
  if (provenance.length === 0) {
    return <Empty title="No claim provenance was recorded for this draft." />;
  }
  return (
    <ul className="draft-claim-provenance-list">
      {provenance.map((claim) => (
        <li key={claim.claimId} className="draft-claim-provenance-item">
          <p className="draft-claim-text">{claim.generatedText}</p>
          <dl className="detail-list" aria-label={`Provenance for claim ${claim.claimId}`}>
            <div>
              <dt>Section</dt>
              <dd>{claim.section}</dd>
            </div>
            <div>
              <dt>Bound contact facts</dt>
              <dd className="mono">
                {claim.contactFactIds.length > 0 ? claim.contactFactIds.join(", ") : "None"}
              </dd>
            </div>
            <div>
              <dt>Profile grounded</dt>
              <dd>{claim.profileGrounded ? "Yes" : "No"}</dd>
            </div>
            <div>
              <dt>Rationale</dt>
              <dd>{claim.rationale}</dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}
