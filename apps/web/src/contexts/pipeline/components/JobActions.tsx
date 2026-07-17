import type { JSX } from "react";
import type { Stage } from "@jobctrl/contracts";

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
import { RunJobStageButton } from "./RunJobStageButton.js";
import { buttonVariants } from "../../../shared/ui/button.js";

export interface JobActionsProps {
  jobId: string;
  currentStage: Stage;
  canRetryStage?: boolean;
  canRunCurrentStage?: boolean;
  canRetailor?: boolean;
  applyApprovalRequired?: boolean;
  activeApplyRunId?: string | null;
}

export function JobActions({
  jobId,
  currentStage,
  canRetryStage = false,
  canRunCurrentStage = true,
  canRetailor = false,
  applyApprovalRequired = true,
  activeApplyRunId = null,
}: JobActionsProps): JSX.Element {
  return (
    <div className="action-panel" role="toolbar" aria-label="Job actions">
      <div
        className="job-action-group"
        role="group"
        aria-label="Preparation actions"
      >
        {canRetryStage ? (
          <RetryStageButton
            className={buttonVariants({ size: "sm", variant: "default" })}
            jobId={jobId}
            stage={currentStage}
            runAfter={shouldRunAfterRetry(currentStage)}
          />
        ) : null}
        <RunJobStageButton
          className={buttonVariants({ size: "sm", variant: "outline" })}
          disabled={!canRunCurrentStage}
          jobId={jobId}
          stage={currentStage}
        />
        <CancelStageButton
          className={buttonVariants({ size: "sm", variant: "warning" })}
          jobId={jobId}
          stage={currentStage}
        />
        <RescoreJobButton
          className={buttonVariants({ size: "sm", variant: "outline" })}
          jobId={jobId}
        />
        <GenerateMaterialsButton
          className={buttonVariants({ size: "sm", variant: "outline" })}
          jobId={jobId}
        />
        {canRetailor ? (
          <RetailorJobButton
            className={buttonVariants({ size: "sm", variant: "secondary" })}
            jobId={jobId}
          />
        ) : null}
      </div>
      <div
        className="job-action-group"
        role="group"
        aria-label="Application actions"
      >
        <DryRunButton
          className={buttonVariants({ size: "sm", variant: "outline" })}
          jobId={jobId}
        />
        {!applyApprovalRequired ? (
          <ApplyButton
            className={buttonVariants({ size: "sm", variant: "default" })}
            jobId={jobId}
          />
        ) : null}
        <CancelApplyButton
          className={buttonVariants({ size: "sm", variant: "warning" })}
          jobId={jobId}
          {...(activeApplyRunId ? { runId: activeApplyRunId } : {})}
        />
        <MarkAppliedButton
          className={buttonVariants({ size: "sm", variant: "success" })}
          jobId={jobId}
        />
        <MarkSkippedButton
          className={buttonVariants({ size: "sm", variant: "ghost" })}
          jobId={jobId}
        />
      </div>
    </div>
  );
}

function shouldRunAfterRetry(stage: Stage): boolean {
  return stage !== "discover";
}
