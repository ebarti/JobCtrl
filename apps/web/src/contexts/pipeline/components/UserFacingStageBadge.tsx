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

  return (
    <span aria-label={visibleStage} className={`stage-pill ${stageTone(visibleStage)}`}>
      {visibleStage}
    </span>
  );
}
