import type { ApplyReviewDecisionValue, ApplyReviewQueueItem } from "@jobhunter/contracts";

import { Button } from "../../../shared/ui/button.js";
import { useApplyReviewDecisionMutation } from "../hooks/useApplyReviewMutations.js";

export interface ApplyReviewDecisionControlsProps {
  readonly item: ApplyReviewQueueItem;
}

const DECISION_LABELS: Record<ApplyReviewDecisionValue, string> = {
  approve_submit: "Approve submit",
  approve_dry_run: "Dry run",
  defer: "Defer",
  decline: "Decline",
  reset: "Reset",
};

const DECISION_REASONS: Record<ApplyReviewDecisionValue, string> = {
  approve_submit: "Approved for submit from the review queue.",
  approve_dry_run: "Approved for dry-run validation from the review queue.",
  defer: "Deferred from the review queue.",
  decline: "Declined from the review queue.",
  reset: "Reset review decision from the review queue.",
};

const PRIMARY_DECISIONS: readonly ApplyReviewDecisionValue[] = [
  "approve_submit",
  "approve_dry_run",
  "defer",
  "decline",
];

export function ApplyReviewDecisionControls({ item }: ApplyReviewDecisionControlsProps) {
  const decision = useApplyReviewDecisionMutation();
  const pending = decision.isPending;

  const submitDecision = (value: ApplyReviewDecisionValue) => {
    decision.mutate({
      jobId: item.jobKey,
      body: {
        decision: value,
        reason: DECISION_REASONS[value],
        decidedBy: "user",
      },
    });
  };

  return (
    <div className="apply-review-actions">
      {PRIMARY_DECISIONS.map((value) => (
        <Button
          key={value}
          size="sm"
          type="button"
          variant={value === "decline" ? "outline" : value === "defer" ? "secondary" : "default"}
          disabled={pending}
          aria-label={`${DECISION_LABELS[value]} for ${item.title}`}
          onClick={() => submitDecision(value)}
        >
          {pending ? "Saving" : DECISION_LABELS[value]}
        </Button>
      ))}
      {item.review.state !== "pending" ? (
        <Button
          size="sm"
          type="button"
          variant="ghost"
          disabled={pending}
          aria-label={`Reset review for ${item.title}`}
          onClick={() => submitDecision("reset")}
        >
          Reset
        </Button>
      ) : null}
      {decision.isError ? <span className="danger">Decision failed</span> : null}
    </div>
  );
}
