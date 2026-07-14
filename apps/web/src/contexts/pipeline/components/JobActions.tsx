import type { JSX } from "react";
import type { Stage } from "@jobctrl/contracts";
import { IconDots } from "@tabler/icons-react";

import { ApplyButton } from "../../apply/components/ApplyButton.js";
import { CancelApplyButton } from "../../apply/components/CancelApplyButton.js";
import { DryRunButton } from "../../apply/components/DryRunButton.js";
import { GenerateMaterialsButton } from "../../materials/components/GenerateMaterialsButton.js";
import { RetailorJobButton } from "../../materials/components/RetailorCurrentPolicyButton.js";
import { RescoreJobButton } from "../../scoring/components/RescoreCurrentPolicyButton.js";
import { Button } from "../../../shared/ui/button.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../shared/ui/popover.js";
import { CancelStageButton } from "./CancelStageButton.js";
import { MarkAppliedButton } from "./MarkAppliedButton.js";
import { MarkSkippedButton } from "./MarkSkippedButton.js";
import { RetryStageButton } from "./RetryStageButton.js";
import { RunJobStageButton } from "./RunJobStageButton.js";

export interface JobActionsProps {
  jobId: string;
  currentStage: Stage;
  canRetryStage?: boolean;
  canRunCurrentStage?: boolean;
  canRetailor?: boolean;
  applyApprovalRequired?: boolean;
}

export function JobActions({
  jobId,
  currentStage,
  canRetryStage = false,
  canRunCurrentStage = true,
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
      ) : (
        <RunJobStageButton
          disabled={!canRunCurrentStage}
          jobId={jobId}
          stage={currentStage}
        />
      )}
      <GenerateMaterialsButton jobId={jobId} />
      <Popover>
        <PopoverTrigger asChild>
          <Button aria-label="More job actions" size="icon" type="button" variant="outline">
            <IconDots aria-hidden="true" size={16} stroke={1.9} />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          aria-label="Additional job actions"
          className="job-actions-overflow"
        >
          <div className="job-actions-overflow__list">
            {canRetryStage ? (
              <RunJobStageButton
                disabled={!canRunCurrentStage}
                jobId={jobId}
                stage={currentStage}
              />
            ) : null}
            <CancelStageButton jobId={jobId} stage={currentStage} />
            <RescoreJobButton jobId={jobId} />
            {canRetailor ? <RetailorJobButton jobId={jobId} /> : null}
            <DryRunButton jobId={jobId} />
            {!applyApprovalRequired ? <ApplyButton jobId={jobId} /> : null}
            <CancelApplyButton jobId={jobId} />
            <MarkAppliedButton jobId={jobId} />
            <MarkSkippedButton jobId={jobId} />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function shouldRunAfterRetry(stage: Stage): boolean {
  return stage !== "discover";
}
