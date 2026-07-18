import type { ApplyReviewDecisionValue, ApplyReviewQueueItem } from "@jobctrl/contracts";
import {
  IconAlertTriangle,
  IconCheck,
  IconClock,
  IconInfoCircle,
  IconLock,
  IconRefresh,
  IconX,
  type TablerIcon,
} from "@tabler/icons-react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "../../../shared/ui/alert.js";
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
  approve_submit: "Authorize live submit",
  approve_dry_run: "Authorize dry run",
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

const DECISION_ICONS: Record<ApplyReviewDecisionValue, TablerIcon> = {
  approve_submit: IconCheck,
  approve_dry_run: IconCheck,
  defer: IconClock,
  decline: IconX,
  reset: IconRefresh,
};

const PRIMARY_DECISIONS: readonly ApplyReviewDecisionValue[] = [
  "approve_submit",
  "approve_dry_run",
  "defer",
  "decline",
];

type DecisionButtonVariant =
  | "default"
  | "destructive"
  | "ghost"
  | "outline";

function decisionButtonVariant(
  value: ApplyReviewDecisionValue,
  liveSubmitAvailable: boolean,
): DecisionButtonVariant {
  if (value === "approve_submit") {
    return liveSubmitAvailable ? "default" : "outline";
  }
  if (value === "approve_dry_run") {
    return liveSubmitAvailable ? "outline" : "default";
  }
  if (value === "decline") {
    return "destructive";
  }
  return "ghost";
}

const GATE_REASON_LABELS: Record<string, string> = {
  awaiting_approval: "approval not recorded",
  awaiting_dry_run: "full dry-run evidence missing",
  approval_stale_materials: "materials changed since approval",
  approval_stale_profile: "profile changed since approval",
  approval_stale_url: "application URL changed since approval",
  approval_stale_email_candidate: "email application changed since approval",
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
  const liveSubmitAvailable =
    fullDryRunEvidence !== null && approvalDisabledReason === null;
  const gateMessage = item.approvalGate.reasons
    .map((reason) => GATE_REASON_LABELS[reason] ?? reason)
    .join(", ");
  const approvalMessage =
    approvalDisabledReason ??
    approvalNotice ??
    (gateMessage ? `Submit gate: ${gateMessage}.` : null);
  const approvalBlocked = approvalDisabledReason !== null || (approvalNotice === null && Boolean(gateMessage));

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
              ...(item.emailApplication
                ? {
                    emailRecipient: item.emailApplication.recipient,
                    emailAttachmentArtifactId: item.emailApplication.attachmentArtifactId,
                  }
                : {}),
            }
          : {}),
        ...(partialOverrideRunId ? { partialOverrideRunId } : {}),
      },
    });
  };

  return (
    <div
      className="apply-review-actions"
      aria-label={`Authorization decision for ${item.title}`}
      role="group"
    >
      <div className="apply-review-approval-summary">
        <p data-typography="body">
          <strong data-typography="strong-body">Authorization only:</strong> this records permission for the
          worker; it does not start or submit an application immediately.
        </p>
        <details className="apply-review-authorization-details">
          <summary data-typography="control">Technical details</summary>
          <dl>
            <div>
              <dt data-typography="label">Materials generation</dt>
              <dd data-typography="body">{formatBindingValue(item.approvalGate.materialsGeneration)}</dd>
            </div>
            <div>
              <dt data-typography="label">Profile version</dt>
              <dd data-typography="body">{formatBindingValue(item.approvalGate.profileVersion)}</dd>
            </div>
            <div>
              <dt data-typography="label">Application URL</dt>
              <dd data-typography="body">{formatBindingValue(item.approvalGate.applicationUrl)}</dd>
            </div>
            {item.emailApplication ? (
              <div>
                <dt data-typography="label">Email recipient</dt>
                <dd data-typography="body">{item.emailApplication.recipient}</dd>
              </div>
            ) : null}
            <div>
              <dt data-typography="label">Dry-run evidence</dt>
              <dd data-typography="body">{dryRunEvidenceLabel(item)}</dd>
            </div>
          </dl>
        </details>
      </div>
      <div className="apply-review-decision-buttons">
        {primaryDecisions.map((value) => {
          const DecisionIcon = DECISION_ICONS[value];
          return (
            <Button
              key={value}
              size="sm"
              type="button"
              variant={decisionButtonVariant(value, liveSubmitAvailable)}
              disabled={
                pending ||
                (approvalDisabledReason !== null && value.startsWith("approve_")) ||
                (value === "approve_submit" && !fullDryRunEvidence)
              }
              aria-label={`${DECISION_LABELS[value]} for ${item.title}`}
              title={
                value === "approve_submit" && !fullDryRunEvidence
                  ? "Full dry-run evidence is required before live-submit authorization."
                  : value.startsWith("approve_")
                    ? approvalMessage ?? undefined
                    : undefined
              }
              onClick={() => {
                void submitDecision(value);
              }}
            >
              <DecisionIcon aria-hidden="true" data-icon="inline-start" />
              {preparingDecision === value ? "Rendering" : decision.isPending ? "Saving" : DECISION_LABELS[value]}
            </Button>
          );
        })}
        {item.review.state !== "pending" ? (
          <Button
            size="sm"
            type="button"
            variant="ghost"
            disabled={pending}
            aria-label={`Reset review for ${item.title}`}
            onClick={() => submitDecision("reset")}
          >
            <IconRefresh aria-hidden="true" data-icon="inline-start" />
            Reset
          </Button>
        ) : null}
      </div>
      {!fullDryRunEvidence && partialDryRunEvidence ? (
        <div className="apply-review-partial-approval">
          <Alert className="apply-review-approval-block" variant="warning">
            <IconLock aria-hidden="true" />
            <AlertTitle>Partial dry-run evidence only</AlertTitle>
            <AlertDescription>
              Blocked channels: {partialDryRunEvidence.blockedChannels.length
                ? partialDryRunEvidence.blockedChannels.join(", ")
                : "not recorded"}
              .
            </AlertDescription>
          </Alert>
          <Button
            size="sm"
            type="button"
            variant="outline"
            disabled={pending || approvalDisabledReason !== null}
            aria-label={`Authorize live submit with partial dry-run evidence for ${item.title}`}
            onClick={() => {
              void submitDecision("approve_submit", partialDryRunEvidence.runId);
            }}
          >
            <IconCheck aria-hidden="true" data-icon="inline-start" />
            Authorize live submit with partial evidence
          </Button>
        </div>
      ) : null}
      {approvalMessage ? (
        <Alert
          className="apply-review-approval-block"
          variant={approvalBlocked ? "warning" : "info"}
          role={approvalBlocked ? "alert" : "status"}
          aria-live={approvalBlocked ? "assertive" : "polite"}
        >
          {approvalBlocked ? (
            <IconLock aria-hidden="true" />
          ) : (
            <IconInfoCircle aria-hidden="true" />
          )}
          <AlertTitle>{approvalBlocked ? "Authorization unavailable" : "Authorization status"}</AlertTitle>
          <AlertDescription>{approvalMessage}</AlertDescription>
        </Alert>
      ) : null}
      {decision.isError ? (
        <Alert className="danger" variant="destructive">
          <IconAlertTriangle aria-hidden="true" />
          <AlertTitle>Decision failed</AlertTitle>
          <AlertDescription>Your authorization decision was not saved. Try again.</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
