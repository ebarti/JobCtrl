import type {
  ApplyReviewDecisionValue,
  ApplyReviewQueueItem,
} from "@jobctrl/contracts";
import {
  IconAlertTriangle,
  IconCheck,
  IconClock,
  IconLock,
  IconMinus,
  IconRefresh,
  IconX,
  type TablerIcon,
} from "@tabler/icons-react";
import { useState } from "react";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../../shared/ui/alert.js";
import { Button } from "../../../shared/ui/button.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../shared/ui/table.js";
import { useApplyReviewDecisionMutation } from "../hooks/useApplyReviewMutations.js";

export interface ApplyReviewDecisionControlsProps {
  readonly item: ApplyReviewQueueItem;
  readonly approvalDisabledReason?: string | null;
  readonly liveSubmitDisabledReason?: string | null;
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

type DecisionButtonVariant = "default" | "destructive" | "ghost" | "outline";

type GateStateTone = "blocked" | "neutral" | "passed" | "pending";

interface GateRow {
  readonly detail: string;
  readonly gate: string;
  readonly state: string;
  readonly tone: GateStateTone;
}

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

function joinedDetails(...details: Array<string | null | undefined>): string {
  return [
    ...new Set(details.filter((detail): detail is string => Boolean(detail))),
  ].join(" ");
}

function bindingComparison<T>(
  recorded: T | null | undefined,
  current: T | null,
): "match" | "mismatch" | "unknown" {
  if (recorded === null || recorded === undefined || current === null) {
    return "unknown";
  }
  return recorded === current ? "match" : "mismatch";
}

function staleBindingLabels(item: ApplyReviewQueueItem): string[] {
  const labels = new Set(
    item.approvalGate.reasons
      .filter((reason) => reason.startsWith("approval_stale_"))
      .map((reason) => GATE_REASON_LABELS[reason] ?? reason),
  );
  if (item.review.state !== "approved_submit") return [...labels];
  if (
    bindingComparison(
      item.review.materialsGeneration,
      item.approvalGate.materialsGeneration,
    ) === "mismatch"
  ) {
    labels.add("materials changed since approval");
  }
  if (
    bindingComparison(
      item.review.profileVersion,
      item.approvalGate.profileVersion,
    ) === "mismatch"
  ) {
    labels.add("profile changed since approval");
  }
  if (
    bindingComparison(
      item.review.applicationUrl,
      item.approvalGate.applicationUrl,
    ) === "mismatch"
  ) {
    labels.add("application URL changed since approval");
  }
  if (
    item.emailApplication &&
    (bindingComparison(
      item.review.emailRecipient,
      item.emailApplication.recipient,
    ) === "mismatch" ||
      bindingComparison(
        item.review.emailAttachmentArtifactId,
        item.emailApplication.attachmentArtifactId,
      ) === "mismatch")
  ) {
    labels.add("email application changed since approval");
  }
  return [...labels];
}

function approvalGateRow(item: ApplyReviewQueueItem): GateRow {
  const staleReasons = staleBindingLabels(item);
  if (staleReasons.length) {
    return {
      gate: "Approval recorded",
      state: "stale",
      tone: "blocked",
      detail: `The recorded approval no longer matches: ${staleReasons.join(", ")}.`,
    };
  }
  if (item.approvalGate.reasons.includes("awaiting_approval")) {
    return {
      gate: "Approval recorded",
      state: "not recorded",
      tone: "pending",
      detail:
        "Live submit stays locked until an approval is bound to the reviewed application inputs.",
    };
  }
  if (item.review.state === "approved_submit") {
    return {
      gate: "Approval recorded",
      state: "recorded",
      tone: "passed",
      detail:
        "Live-submit authorization is bound to the reviewed application inputs.",
    };
  }
  if (item.review.state === "approved_dry_run") {
    return {
      gate: "Approval recorded",
      state: "live approval not recorded",
      tone: "pending",
      detail:
        "Dry run is authorized; live-submit authorization is still required.",
    };
  }
  if (item.review.state === "deferred" || item.review.state === "declined") {
    return {
      gate: "Approval recorded",
      state: item.review.state,
      tone: "neutral",
      detail: "Live submit stays locked until a new approval is recorded.",
    };
  }
  return {
    gate: "Approval recorded",
    state: "not recorded",
    tone: "pending",
    detail:
      "Live submit stays locked until an approval is bound to the reviewed application inputs.",
  };
}

function dryRunGateRow(item: ApplyReviewQueueItem): GateRow {
  const {
    dryRunEvidence: full,
    partialDryRunEvidence: partial,
    reasons,
  } = item.approvalGate;
  if (reasons.includes("override_evidence_invalid")) {
    return {
      gate: "Dry-run evidence",
      state: "override invalid",
      tone: "blocked",
      detail: joinedDetails(
        "The partial dry-run override no longer matches the reviewed application inputs.",
        partial ? `Last partial evidence: ${partial.runId}.` : null,
      ),
    };
  }
  if (reasons.includes("awaiting_dry_run")) {
    return {
      gate: "Dry-run evidence",
      state: partial ? "partial only" : "none",
      tone: partial ? "pending" : "neutral",
      detail: partial
        ? `Run ${partial.runId} did not cover: ${partial.blockedChannels.join(", ") || "channels not recorded"}.`
        : "Authorize a dry run to rehearse the application without submitting.",
    };
  }
  if (full) {
    return {
      gate: "Dry-run evidence",
      state: "full",
      tone: "passed",
      detail: `Run ${full.runId} completed with full coverage.`,
    };
  }
  if (partial) {
    return {
      gate: "Dry-run evidence",
      state: "partial only",
      tone: "pending",
      detail: `Run ${partial.runId} did not cover: ${partial.blockedChannels.join(", ") || "channels not recorded"}.`,
    };
  }
  return {
    gate: "Dry-run evidence",
    state: "none",
    tone: "neutral",
    detail:
      "Authorize a dry run to rehearse the application without submitting.",
  };
}

function gateRows(
  item: ApplyReviewQueueItem,
  approvalDisabledReason: string | null,
  liveSubmitDisabledReason: string | null,
  approvalNotice: string | null,
  approvalPreparing: boolean,
): GateRow[] {
  const reasons = item.approvalGate.reasons;
  const hasLiveApproval = item.review.state === "approved_submit";
  const materialsComparison = hasLiveApproval
    ? bindingComparison(
        item.review.materialsGeneration,
        item.approvalGate.materialsGeneration,
      )
    : "unknown";
  const profileComparison = hasLiveApproval
    ? bindingComparison(
        item.review.profileVersion,
        item.approvalGate.profileVersion,
      )
    : "unknown";
  const urlComparison = hasLiveApproval
    ? bindingComparison(
        item.review.applicationUrl,
        item.approvalGate.applicationUrl,
      )
    : "unknown";
  const emailComparison =
    hasLiveApproval && item.emailApplication
      ? item.review.emailRecipient === null ||
        item.review.emailRecipient === undefined ||
        item.review.emailAttachmentArtifactId === null ||
        item.review.emailAttachmentArtifactId === undefined
        ? "unknown"
        : item.review.emailRecipient === item.emailApplication.recipient &&
            item.review.emailAttachmentArtifactId ===
              item.emailApplication.attachmentArtifactId
          ? "match"
          : "mismatch"
      : "unknown";
  const materialsStale =
    reasons.includes("approval_stale_materials") ||
    materialsComparison === "mismatch";
  const profileStale =
    reasons.includes("approval_stale_profile") ||
    profileComparison === "mismatch";
  const urlStale =
    reasons.includes("approval_stale_url") || urlComparison === "mismatch";
  const emailStale =
    reasons.includes("approval_stale_email_candidate") ||
    emailComparison === "mismatch";
  const materialsDetail = joinedDetails(
    approvalDisabledReason,
    approvalNotice,
    materialsStale
      ? "The materials changed after approval; record a new approval for the current generation."
      : materialsComparison === "match"
        ? `The recorded approval is bound to materials generation ${item.approvalGate.materialsGeneration}.`
        : item.approvalGate.materialsGeneration === null
          ? "No materials generation is available for approval."
          : `Materials generation ${item.approvalGate.materialsGeneration} is available for the next approval.`,
  );
  const rows: GateRow[] = [
    approvalGateRow(item),
    dryRunGateRow(item),
    {
      gate: "Materials",
      state: approvalDisabledReason
        ? "blocked"
        : materialsStale
          ? "changed"
          : approvalPreparing
            ? "preparing"
            : approvalNotice
              ? "preparation required"
              : materialsComparison === "match"
                ? "matches approval"
                : item.approvalGate.materialsGeneration === null
                  ? "not recorded"
                  : `generation ${item.approvalGate.materialsGeneration}`,
      tone:
        approvalDisabledReason || materialsStale
          ? "blocked"
          : approvalPreparing || approvalNotice
            ? "pending"
            : materialsComparison === "match"
              ? "passed"
              : "neutral",
      detail: materialsDetail,
    },
    {
      gate: "Profile version",
      state: profileStale
        ? "changed"
        : profileComparison === "match"
          ? "matches approval"
          : item.approvalGate.profileVersion === null
            ? "not recorded"
            : `v${item.approvalGate.profileVersion}`,
      tone: profileStale
        ? "blocked"
        : profileComparison === "match"
          ? "passed"
          : item.approvalGate.profileVersion === null
            ? "neutral"
            : "neutral",
      detail: profileStale
        ? "The profile changed after approval; record a new approval against the current version."
        : profileComparison === "match"
          ? "This profile version matches the recorded approval."
          : item.approvalGate.profileVersion === null
            ? "No profile version is available for the approval binding."
            : "This profile version is available for the next approval.",
    },
    {
      gate: "Application URL",
      state: urlStale
        ? "changed"
        : urlComparison === "match"
          ? "matches approval"
          : item.approvalGate.applicationUrl
            ? "recorded"
            : "not recorded",
      tone: urlStale
        ? "blocked"
        : urlComparison === "match"
          ? "passed"
          : item.approvalGate.applicationUrl
            ? "neutral"
            : "neutral",
      detail: urlStale
        ? "The application URL changed after approval; record a new approval for the current destination."
        : urlComparison === "match"
          ? `Matches the destination bound to the recorded approval: ${item.approvalGate.applicationUrl}.`
          : (item.approvalGate.applicationUrl ??
            "No application URL is available for the approval binding."),
    },
  ];
  if (item.emailApplication || emailStale) {
    rows.push({
      gate: "Email application",
      state: emailStale
        ? "changed"
        : emailComparison === "match"
          ? "matches approval"
          : "recorded",
      tone: emailStale
        ? "blocked"
        : emailComparison === "match"
          ? "passed"
          : "neutral",
      detail: emailStale
        ? "The email candidate changed after approval; record a new approval for the current recipient and attachment."
        : emailComparison === "match"
          ? `Matches the recorded approval for ${item.emailApplication?.recipient ?? "the recorded recipient"}.`
          : `Recipient ${item.emailApplication?.recipient ?? "not recorded"}; attachment ${item.emailApplication?.attachmentName ?? "not recorded"}.`,
    });
  }
  rows.push({
    gate: "Repeat application protection",
    state: liveSubmitDisabledReason
      ? "blocked"
      : item.repeatApplication.status === "clear"
        ? "clear"
        : item.repeatApplication.status === "override_ready"
          ? "confirmed"
          : "blocked",
    tone:
      !liveSubmitDisabledReason &&
      (item.repeatApplication.status === "clear" ||
        item.repeatApplication.status === "override_ready")
        ? "passed"
        : "blocked",
    detail: joinedDetails(
      liveSubmitDisabledReason,
      item.repeatApplication.summary,
    ),
  });
  return rows;
}

const GATE_STATE_ICONS: Record<GateStateTone, TablerIcon> = {
  blocked: IconLock,
  neutral: IconMinus,
  passed: IconCheck,
  pending: IconClock,
};

export function ApplyReviewDecisionControls({
  approvalDisabledReason = null,
  liveSubmitDisabledReason = null,
  approvalNotice = null,
  approvalPreparing = false,
  item,
  onPrepareApproval = null,
}: ApplyReviewDecisionControlsProps) {
  const decision = useApplyReviewDecisionMutation();
  const [preparingDecision, setPreparingDecision] =
    useState<ApplyReviewDecisionValue | null>(null);
  const pending =
    decision.isPending || preparingDecision !== null || approvalPreparing;
  const primaryDecisions = PRIMARY_DECISIONS;
  const fullDryRunEvidence = item.approvalGate.dryRunEvidence;
  const partialDryRunEvidence = item.approvalGate.partialDryRunEvidence;
  const liveSubmitAvailable =
    fullDryRunEvidence !== null &&
    approvalDisabledReason === null &&
    liveSubmitDisabledReason === null;
  const submitGateRows = gateRows(
    item,
    approvalDisabledReason,
    liveSubmitDisabledReason,
    approvalNotice,
    approvalPreparing,
  );
  const hasBlockingGate = submitGateRows.some((row) => row.tone === "blocked");

  const submitDecision = async (
    value: ApplyReviewDecisionValue,
    partialOverrideRunId?: string,
  ) => {
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
                    emailAttachmentArtifactId:
                      item.emailApplication.attachmentArtifactId,
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
          <strong data-typography="strong-body">Authorization only:</strong>{" "}
          this records permission for the worker; it does not start or submit an
          application immediately.
        </p>
        <details className="apply-review-authorization-details">
          <summary data-typography="control">Technical details</summary>
          <dl>
            <div>
              <dt data-typography="label">Materials generation</dt>
              <dd data-typography="body">
                {formatBindingValue(item.approvalGate.materialsGeneration)}
              </dd>
            </div>
            <div>
              <dt data-typography="label">Profile version</dt>
              <dd data-typography="body">
                {formatBindingValue(item.approvalGate.profileVersion)}
              </dd>
            </div>
            <div>
              <dt data-typography="label">Application URL</dt>
              <dd data-typography="body">
                {formatBindingValue(item.approvalGate.applicationUrl)}
              </dd>
            </div>
            {item.emailApplication ? (
              <div>
                <dt data-typography="label">Email recipient</dt>
                <dd data-typography="body">
                  {item.emailApplication.recipient}
                </dd>
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
                (approvalDisabledReason !== null &&
                  value.startsWith("approve_")) ||
                (value === "approve_submit" &&
                  liveSubmitDisabledReason !== null) ||
                (value === "approve_submit" && !fullDryRunEvidence)
              }
              aria-label={`${DECISION_LABELS[value]} for ${item.title}`}
              title={
                value === "approve_submit" && !fullDryRunEvidence
                  ? "Full dry-run evidence is required before live-submit authorization."
                  : value.startsWith("approve_")
                    ? (approvalDisabledReason ??
                      liveSubmitDisabledReason ??
                      approvalNotice ??
                      undefined)
                    : undefined
              }
              onClick={() => {
                void submitDecision(value);
              }}
            >
              <DecisionIcon aria-hidden="true" data-icon="inline-start" />
              {preparingDecision === value
                ? "Rendering"
                : decision.isPending
                  ? "Saving"
                  : DECISION_LABELS[value]}
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
              Blocked channels:{" "}
              {partialDryRunEvidence.blockedChannels.length
                ? partialDryRunEvidence.blockedChannels.join(", ")
                : "not recorded"}
              .
            </AlertDescription>
          </Alert>
          <Button
            size="sm"
            type="button"
            variant="outline"
            disabled={
              pending ||
              approvalDisabledReason !== null ||
              liveSubmitDisabledReason !== null
            }
            aria-label={`Authorize live submit with partial dry-run evidence for ${item.title}`}
            onClick={() => {
              void submitDecision(
                "approve_submit",
                partialDryRunEvidence.runId,
              );
            }}
          >
            <IconCheck aria-hidden="true" data-icon="inline-start" />
            Authorize live submit with partial evidence
          </Button>
        </div>
      ) : null}
      <div
        className="apply-review-gates"
        aria-live={hasBlockingGate ? "assertive" : "polite"}
      >
        <Table aria-label="Submit gates">
          <TableHeader>
            <TableRow>
              <TableHead>Gate</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Detail</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {submitGateRows.map((row) => {
              const StateIcon = GATE_STATE_ICONS[row.tone];
              return (
                <TableRow key={row.gate}>
                  <TableCell data-label="Gate">{row.gate}</TableCell>
                  <TableCell data-label="State">
                    <span
                      className="apply-review-gate-state"
                      data-tone={row.tone}
                    >
                      <StateIcon aria-hidden="true" />
                      {row.state}
                    </span>
                  </TableCell>
                  <TableCell data-label="Detail">{row.detail}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {decision.isError ? (
        <Alert className="danger" variant="destructive">
          <IconAlertTriangle aria-hidden="true" />
          <AlertTitle>Decision failed</AlertTitle>
          <AlertDescription>
            Your authorization decision was not saved. Try again.
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
