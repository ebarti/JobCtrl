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

const GATE_REASON_LABELS: Record<string, string> = {
  awaiting_approval: "approval not recorded",
  awaiting_dry_run: "full dry-run evidence missing",
  approval_stale_materials: "materials changed since approval",
  approval_stale_profile: "profile changed since approval",
  approval_stale_url: "application URL changed since approval",
  override_evidence_invalid: "partial dry-run override no longer matches",
};

function formatBindingValue(value: number | string | null): string {
  return value === null || value === "" ? "not recorded" : String(value);
}

function dryRunEvidenceLabel(item: ApplyReviewQueueItem): string {
  const full = item.approvalGate.dryRunEvidence;
  if (full) {
    return `full dry-run evidence from ${full.runId}`;
  }
  const partial = item.approvalGate.partialDryRunEvidence;
  if (partial) {
    return `partial dry-run evidence from ${partial.runId}`;
  }
  return "no matching dry-run evidence";
}

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
  const fullDryRunEvidence = item.approvalGate.dryRunEvidence;
  const partialDryRunEvidence = item.approvalGate.partialDryRunEvidence;
  const gateMessage = item.approvalGate.reasons
    .map((reason) => GATE_REASON_LABELS[reason] ?? reason)
    .join(", ");
  const approvalMessage =
    approvalDisabledReason ??
    approvalNotice ??
    (gateMessage ? `Submit gate: ${gateMessage}.` : null);

  const submitDecision = async (value: ApplyReviewDecisionValue, partialOverrideRunId?: string) => {
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
        ...(value === "approve_submit"
          ? {
              materialsGeneration: item.approvalGate.materialsGeneration,
              profileVersion: item.approvalGate.profileVersion,
              applicationUrl: item.approvalGate.applicationUrl,
            }
          : {}),
        ...(partialOverrideRunId ? { partialOverrideRunId } : {}),
      },
    });
  };

  return (
    <div className="apply-review-actions">
      <div className="apply-review-approval-binding" aria-label={`Submit approval binding for ${item.title}`}>
        <span>Materials generation: {formatBindingValue(item.approvalGate.materialsGeneration)}</span>
        <span>Profile version: {formatBindingValue(item.approvalGate.profileVersion)}</span>
        <span>Application URL: {formatBindingValue(item.approvalGate.applicationUrl)}</span>
        <span>Dry-run evidence: {dryRunEvidenceLabel(item)}</span>
      </div>
      {primaryDecisions.map((value) => (
        <Button
          key={value}
          size="sm"
          type="button"
          variant={value === "decline" ? "outline" : value === "defer" ? "secondary" : "default"}
          disabled={
            pending ||
            (approvalDisabledReason !== null && value.startsWith("approve_")) ||
            (value === "approve_submit" && !fullDryRunEvidence)
          }
          aria-label={`${DECISION_LABELS[value]} for ${item.title}`}
          title={
            value === "approve_submit" && !fullDryRunEvidence
              ? "Full dry-run evidence is required before submit approval."
              : value.startsWith("approve_")
                ? approvalMessage ?? undefined
                : undefined
          }
          onClick={() => {
            void submitDecision(value);
          }}
        >
          {preparingDecision === value ? "Rendering" : decision.isPending ? "Saving" : DECISION_LABELS[value]}
        </Button>
      ))}
      {!fullDryRunEvidence && partialDryRunEvidence ? (
        <>
          <span className="apply-review-approval-block" role="alert">
            Partial dry-run evidence only. Blocked channels:{" "}
            {partialDryRunEvidence.blockedChannels.length
              ? partialDryRunEvidence.blockedChannels.join(", ")
              : "not recorded"}
            .
          </span>
          <Button
            size="sm"
            type="button"
            variant="secondary"
            disabled={pending || approvalDisabledReason !== null}
            aria-label={`Approve with partial dry-run evidence for ${item.title}`}
            onClick={() => {
              void submitDecision("approve_submit", partialDryRunEvidence.runId);
            }}
          >
            Approve with partial dry-run evidence
          </Button>
        </>
      ) : null}
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
