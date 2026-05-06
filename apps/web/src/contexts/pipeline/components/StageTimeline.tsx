import type { JSX } from "react";
import type { StageSummary } from "@jobhunter/contracts";

import { StatusDot } from "../../../shared/ui/status-dot.js";
import { StageBadge } from "./StageBadge.js";

export interface StageTimelineProps {
  stages: readonly StageSummary[];
}

export function StageTimeline({ stages }: StageTimelineProps): JSX.Element {
  return (
    <ol className="timeline">
      {stages.map((stage) => (
        <li key={stage.stage} className="timeline-row">
          <StatusDot state={stage.state} />
          <StageBadge stage={stage.stage} />
          <StageBadge state={stage.state} />
          {stage.nextAction ? <small>{stage.nextAction}</small> : null}
        </li>
      ))}
    </ol>
  );
}
