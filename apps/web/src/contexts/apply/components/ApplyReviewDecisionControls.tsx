import type { ApplyReviewDecisionValue, ApplyReviewQueueItem } from "@jobhunter/contracts";
import { useState } from "react";

import { Button } from "../../../shared/ui/button.js";
import { useApplyReviewDecisionMutation } from "../hooks/useApplyReviewMutations.js";

export interface ApplyReviewDecisionControlsProps {
  readonly item: ApplyReviewQueueItem;
  readonly approvalDisabledReason?: string | null;
  readonly approvalNotice?: string | null;
  readonly approvalPreparing?: boolean;
  readonly onPrepareApproval?: (() => Promise<boolean>) | null;
}

const DECISION_LABELS: Record<ApplyReviewDecisionValue, string> = {
  approve_submit: "Approve submit",
  approve_dry_run: "Approve dry run",
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

export function ApplyReviewDecisionControls({
  approvalDisabledReason = null,
  approvalNotice = null,
  approvalPreparing = false,
  item,
  onPrepareApproval = null,
}: ApplyReviewDecisionControlsProps) {
  const decision = useApplyReviewDecisionMutation();
  const [preparingDecision, setPreparingDecision] = useState<ApplyReviewDecisionValue | null>(null);
  const pending = decision.isPending || preparingDecision !== null || approvalPreparing;
  const primaryDecisions = PRIMARY_DECISIONS;
  const approvalMessage = approvalDisabledReason ?? approvalNotice;

  const submitDecision = async (value: ApplyReviewDecisionValue) => {
    if (pending) return;
    if (value.startsWith("approve_") && onPrepareApproval) {
      setPreparingDecision(value);
      try {
        const prepared = await onPrepareApproval();
        if (!prepared) return;
      } catch {
        return;
      } finally {
        setPreparingDecision(null);
      }
    }
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
      {primaryDecisions.map((value) => (
        <Button
          key={value}
          size="sm"
          type="button"
          variant={value === "decline" ? "outline" : value === "defer" ? "secondary" : "default"}
          disabled={pending || (approvalDisabledReason !== null && value.startsWith("approve_"))}
          aria-label={`${DECISION_LABELS[value]} for ${item.title}`}
          title={value.startsWith("approve_") ? approvalMessage ?? undefined : undefined}
          onClick={() => {
            void submitDecision(value);
          }}
        >
          {preparingDecision === value ? "Rendering" : decision.isPending ? "Saving" : DECISION_LABELS[value]}
        </Button>
      ))}
      {approvalMessage ? (
        <span className="apply-review-approval-block" role="status">
          {approvalMessage}
        </span>
      ) : null}
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
