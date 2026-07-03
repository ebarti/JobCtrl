import type { JSX } from "react";
import type { Stage } from "@jobhunter/contracts";
import { Link } from "@tanstack/react-router";

import { ApplyButton } from "../../apply/components/ApplyButton.js";
import { CancelApplyButton } from "../../apply/components/CancelApplyButton.js";
import { DryRunButton } from "../../apply/components/DryRunButton.js";
import { GenerateMaterialsButton } from "../../materials/components/GenerateMaterialsButton.js";
import { RetailorJobButton } from "../../materials/components/RetailorCurrentPolicyButton.js";
import { RescoreJobButton } from "../../scoring/components/RescoreCurrentPolicyButton.js";
import { CancelStageButton } from "./CancelStageButton.js";
import { MarkAppliedButton } from "./MarkAppliedButton.js";
import { MarkSkippedButton } from "./MarkSkippedButton.js";
import { RetryStageButton } from "./RetryStageButton.js";

export interface JobActionsProps {
  jobId: string;
  currentStage: Stage;
  canRetryStage?: boolean;
  canRetailor?: boolean;
  applyApprovalRequired?: boolean;
}

export function JobActions({
  jobId,
  currentStage,
  canRetryStage = false,
  canRetailor = false,
  applyApprovalRequired = true,
}: JobActionsProps): JSX.Element {
  return (
    <div className="action-panel" role="toolbar" aria-label="Job actions">
      {canRetryStage ? (
        <RetryStageButton
          jobId={jobId}
          stage={currentStage}
          runAfter={shouldRunAfterRetry(currentStage)}
        />
      ) : null}
      <CancelStageButton jobId={jobId} stage={currentStage} />
      <RescoreJobButton jobId={jobId} />
      <GenerateMaterialsButton jobId={jobId} />
      {canRetailor ? <RetailorJobButton jobId={jobId} /> : null}
      <DryRunButton jobId={jobId} />
      {applyApprovalRequired ? (
        <Link className="tab on" search={{ jobKey: jobId }} to="/apply-review">
          apply review
        </Link>
      ) : (
        <ApplyButton jobId={jobId} />
      )}
      <CancelApplyButton jobId={jobId} />
      <MarkAppliedButton jobId={jobId} />
      <MarkSkippedButton jobId={jobId} />
    </div>
  );
}

function shouldRunAfterRetry(stage: Stage): boolean {
  return stage !== "discover";
}
