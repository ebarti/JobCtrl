import type { JSX } from "react";

import { Badge } from "../../../shared/ui/badge.js";
import type { Stage } from "../../operations/types.js";

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
    <Badge aria-label={visibleStage} variant="category">
      {stageLabel(visibleStage)}
    </Badge>
  );
}

function stageLabel(stage: "discover" | "apply"): string {
  return `${stage.charAt(0).toUpperCase()}${stage.slice(1)}`;
}
