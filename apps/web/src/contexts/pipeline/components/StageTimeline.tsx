import type { JSX } from "react";
import type { StageSummary } from "@jobhunter/contracts";

import { StatusDot } from "../../../shared/ui/status-dot.js";
import { TailorJobButton } from "../../materials/components/RetailorCurrentPolicyButton.js";
import { StageBadge } from "./StageBadge.js";

export interface StageTimelineProps {
  stages: readonly StageSummary[];
  jobId?: string;
}

export function StageTimeline({ stages, jobId }: StageTimelineProps): JSX.Element {
  return (
    <ol className="timeline">
      {stages.map((stage) => (
        <li key={stage.stage} className="timeline-row">
          <span className="timeline-row-head">
            <StatusDot state={stage.state} />
            <StageBadge stage={stage.stage} />
          </span>
          <StageBadge state={stage.state} />
          {jobId && canTailorFromStage(stage) ? (
            <TailorJobButton className="tab timeline-action" jobId={jobId} />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function canTailorFromStage(stage: StageSummary): boolean {
  return (
    stage.stage === "tailor" &&
    !["queued", "running", "succeeded", "exhausted"].includes(stage.state)
  );
}
