import type { ContactResearchTaskDetail } from "@jobctrl/contracts";
import type { JSX } from "react";

import { Empty } from "../../../shared/ui/empty.js";
import { researchTaskStatusLabel } from "../lib/research-copy.js";
import { CandidateReviewCard } from "./CandidateReviewCard.js";
import { ResearchSourceAttemptList } from "./ResearchSourceAttemptList.js";

export interface CandidateReviewListProps {
  task: ContactResearchTaskDetail;
}

// Supervised review surface (INV-4): renders every proposed candidate with its
// provenance (INV-2) and the per-source attempt outcomes (the search audit),
// each with an explicit Confirm action. Nothing here sends anything (INV-1).
export function CandidateReviewList({ task }: CandidateReviewListProps): JSX.Element {
  return (
    <div className="candidate-review" aria-label="Research candidates">
      <div className="candidate-review-summary">
        <span className="tag">{researchTaskStatusLabel(task.status)}</span>
        <span>
          {task.candidateCount} proposed · {task.needsReviewCount} awaiting review ·{" "}
          {task.confirmedCount} confirmed
        </span>
      </div>
      {task.candidates.length === 0 ? (
        <Empty title="No candidates were proposed. Review the sources attempted below." />
      ) : (
        <ul className="candidate-review-list">
          {task.candidates.map((candidate) => (
            <CandidateReviewCard
              key={candidate.candidateId}
              taskId={task.taskId}
              candidate={candidate}
            />
          ))}
        </ul>
      )}
      <details className="research-source-attempts-block">
        <summary>Sources attempted</summary>
        <ResearchSourceAttemptList attempts={task.sourceAttempts} />
      </details>
    </div>
  );
}
