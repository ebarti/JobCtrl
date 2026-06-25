import type { ApplyReviewDecisionValue, ApplyReviewQueueItem } from "@jobhunter/contracts";

import { Button } from "../../../shared/ui/button.js";
import { useApplyReviewDecisionMutation } from "../hooks/useApplyReviewMutations.js";

export interface ApplyReviewDecisionControlsProps {
  readonly item: ApplyReviewQueueItem;
  readonly approvalDisabledReason?: string | null;
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

function hasCompletedDryRun(item: ApplyReviewQueueItem): boolean {
  const run = item.latestApplyRun;
  if (!run?.dryRun) return false;
  const status = `${run.status} ${run.result ?? ""}`.toLowerCase();
  return status.includes("succeeded") || status.includes("complete");
}

export function ApplyReviewDecisionControls({
  approvalDisabledReason = null,
  item,
}: ApplyReviewDecisionControlsProps) {
  const decision = useApplyReviewDecisionMutation();
  const pending = decision.isPending;
  const primaryDecisions = PRIMARY_DECISIONS.filter(
    (value) => value !== "approve_submit" || hasCompletedDryRun(item),
  );

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
      {primaryDecisions.map((value) => (
        <Button
          key={value}
          size="sm"
          type="button"
          variant={value === "decline" ? "outline" : value === "defer" ? "secondary" : "default"}
          disabled={pending || (approvalDisabledReason !== null && value.startsWith("approve_"))}
          aria-label={`${DECISION_LABELS[value]} for ${item.title}`}
          title={value.startsWith("approve_") ? approvalDisabledReason ?? undefined : undefined}
          onClick={() => submitDecision(value)}
        >
          {pending ? "Saving" : DECISION_LABELS[value]}
        </Button>
      ))}
      {approvalDisabledReason ? (
        <span className="apply-review-approval-block" role="status">
          {approvalDisabledReason}
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
