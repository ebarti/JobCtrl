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
import { StatusBadge } from "../../../shared/ui/status-badge.js";

export interface JobActionsProps {
  jobId: string;
  currentStage: Stage;
  canRetryStage?: boolean;
  canRunCurrentStage?: boolean;
  canRetailor?: boolean;
  applyApprovalRequired?: boolean;
  activeApplyRunId?: string | null;
  isApplied?: boolean;
}

export function JobActions({
  jobId,
  currentStage,
  canRetryStage = false,
  canRunCurrentStage = true,
  canRetailor = false,
  applyApprovalRequired = true,
  activeApplyRunId = null,
  isApplied = false,
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
          label="Run current stage"
          stage={currentStage}
        />
        <CancelStageButton
          className={buttonVariants({ size: "sm", variant: "warning" })}
          jobId={jobId}
          label="Stop current stage"
          stage={currentStage}
        />
        <RescoreJobButton
          className={buttonVariants({ size: "sm", variant: "outline" })}
          jobId={jobId}
          label="Rescore current policy"
        />
        <GenerateMaterialsButton
          className={buttonVariants({ size: "sm", variant: "outline" })}
          jobId={jobId}
          label="Generate materials"
        />
        {canRetailor ? (
          <RetailorJobButton
            className={buttonVariants({ size: "sm", variant: "secondary" })}
            jobId={jobId}
            label="Re-tailor current policy"
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
          label="Stop application run"
          {...(activeApplyRunId ? { runId: activeApplyRunId } : {})}
        />
        {isApplied ? (
          <StatusBadge aria-label="Application status: Applied" tone="ok">
            Applied
          </StatusBadge>
        ) : (
          <MarkAppliedButton
            className={buttonVariants({ size: "sm", variant: "success" })}
            jobId={jobId}
          />
        )}
        <MarkSkippedButton
          className={buttonVariants({ size: "sm", variant: "ghost" })}
          jobId={jobId}
          label="Skip"
        />
      </div>
    </div>
  );
}

function shouldRunAfterRetry(stage: Stage): boolean {
  return stage !== "discover";
}
