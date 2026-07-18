import { IconBan, IconClock, type TablerIcon } from "@tabler/icons-react";
import type { JSX } from "react";

import { StatusBadge } from "../../../shared/ui/status-badge.js";
import { Badge } from "../../../shared/ui/badge.js";
import type { Stage, StageState } from "../../operations/types.js";
import {
  stageStateTone,
  type StageStateTone,
} from "../lib/stage-state-tone.js";

export type StageBadgeProps = { stage: Stage } | { state: StageState };

export function StageBadge(props: StageBadgeProps): JSX.Element {
  if ("stage" in props) {
    return (
      <Badge aria-label={`Stage: ${stageLabel(props.stage)}`} variant="category">
        {stageLabel(props.stage)}
      </Badge>
    );
  }
  const tone: StageStateTone = stageStateTone(props.state);
  return (
    <StatusBadge icon={stageStateIcon(props.state)} tone={tone}>
      {props.state}
    </StatusBadge>
  );
}

function stageLabel(stage: Stage): string {
  return `${stage.charAt(0).toUpperCase()}${stage.slice(1)}`;
}

function stageStateIcon(state: StageState): TablerIcon | undefined {
  if (state === "pending" || state === "queued" || state === "running")
    return IconClock;
  if (state === "blocked" || state === "canceled") return IconBan;
  return undefined;
}
