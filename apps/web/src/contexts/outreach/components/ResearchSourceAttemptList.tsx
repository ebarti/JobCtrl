import type { ContactResearchSourceAttempt } from "@jobctl/contracts";
import type { JSX } from "react";

import { formatDateTime } from "../../../shared/lib/formatters.js";
import { Empty } from "../../../shared/ui/empty.js";
import { contactSourceKindLabel } from "../lib/contact-copy.js";
import { researchSourceOutcomeLabel } from "../lib/research-copy.js";

export interface ResearchSourceAttemptListProps {
  attempts: readonly ContactResearchSourceAttempt[];
}

// Provenance of the search itself (INV-2): which allowed source was tried and
// its first-class outcome (robots / rate-limit / budget / rejected /
// manual-capture), never a scrape error.
export function ResearchSourceAttemptList({
  attempts,
}: ResearchSourceAttemptListProps): JSX.Element {
  if (attempts.length === 0) {
    return <Empty title="No sources have been attempted for this research task yet." />;
  }
  return (
    <ul className="research-source-attempts" aria-label="Sources attempted">
      {attempts.map((attempt, index) => (
        <li key={`${attempt.sourceRef}-${index}`} className="research-source-attempt">
          <span className="tag">{contactSourceKindLabel(_kind(attempt.sourceKind))}</span>
          <span className="research-attempt-outcome">
            {researchSourceOutcomeLabel(attempt.outcome)}
          </span>
          <span className="research-attempt-ref mono">{attempt.sourceRef}</span>
          <span className="research-attempt-time">{formatDateTime(attempt.attemptedAt)}</span>
          {attempt.detail ? (
            <span className="research-attempt-detail">{attempt.detail}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function _kind(value: string): "user_entered" | "public_web_page" | "user_imported_list" | "derived" {
  const allowed = ["user_entered", "public_web_page", "user_imported_list", "derived"];
  return (allowed.includes(value) ? value : "public_web_page") as ReturnType<typeof _kind>;
}
