import type { JSX } from "react";

import type { Stage } from "../../operations/types.js";
import { stageTone } from "../lib/stage-tone.js";

const PREPARATION_STAGES = new Set<Stage>(["discover", "enrich", "score", "tailor", "cover"]);

export function userFacingStage(stage: Stage): "discover" | "apply" {
  return PREPARATION_STAGES.has(stage) ? "discover" : "apply";
}

export interface UserFacingStageBadgeProps {
  readonly stage: Stage;
}

export function UserFacingStageBadge({ stage }: UserFacingStageBadgeProps): JSX.Element {
  const visibleStage = userFacingStage(stage);
  const label =
    visibleStage === stage
      ? visibleStage
      : `${visibleStage}; internal ${stage} substatus`;

  return (
    <span
      aria-label={label}
      className={`stage-pill ${stageTone(visibleStage)}`}
      title={visibleStage === stage ? undefined : `Internal ${stage} substatus`}
    >
      {visibleStage}
    </span>
  );
}
