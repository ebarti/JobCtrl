import type { JSX } from "react";
import type { Stage } from "@jobhunter/contracts";

import { ApplyButton } from "../../apply/components/ApplyButton.js";
import { CancelApplyButton } from "../../apply/components/CancelApplyButton.js";
import { DryRunButton } from "../../apply/components/DryRunButton.js";
import { RetailorJobButton } from "../../materials/components/RetailorCurrentPolicyButton.js";
import { RescoreJobButton } from "../../scoring/components/RescoreCurrentPolicyButton.js";
import { CancelStageButton } from "./CancelStageButton.js";
import { MarkAppliedButton } from "./MarkAppliedButton.js";
import { MarkSkippedButton } from "./MarkSkippedButton.js";
import { RetryStageButton } from "./RetryStageButton.js";

export interface JobActionsProps {
  jobId: string;
  currentStage: Stage;
  nextAction?: string | null;
  canRetailor?: boolean;
}

export function JobActions({ jobId, currentStage, nextAction, canRetailor = false }: JobActionsProps): JSX.Element {
  return (
    <div className="action-panel" role="toolbar" aria-label="Job actions">
      {nextAction ? <span className="next-action">{nextAction}</span> : null}
      <RetryStageButton jobId={jobId} stage={currentStage} />
      <CancelStageButton jobId={jobId} stage={currentStage} />
      <RescoreJobButton jobId={jobId} />
      {canRetailor ? <RetailorJobButton jobId={jobId} /> : null}
      <DryRunButton jobId={jobId} />
      <ApplyButton jobId={jobId} />
      <CancelApplyButton jobId={jobId} />
      <MarkAppliedButton jobId={jobId} />
      <MarkSkippedButton jobId={jobId} />
    </div>
  );
}
