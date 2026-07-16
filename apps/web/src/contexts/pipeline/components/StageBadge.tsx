import { IconBan, IconClock, type TablerIcon } from "@tabler/icons-react";
import type { JSX } from "react";

import { StatusBadge } from "../../../shared/ui/status-badge.js";
import type { Stage, StageState } from "../../operations/types.js";
import {
  stageStateTone,
  type StageStateTone,
} from "../lib/stage-state-tone.js";
import { stageTone, type StageTone } from "../lib/stage-tone.js";

export type StageBadgeProps = { stage: Stage } | { state: StageState };

export function StageBadge(props: StageBadgeProps): JSX.Element {
  if ("stage" in props) {
    const tone: StageTone = stageTone(props.stage);
    return <span className={`stage-pill ${tone}`}>{props.stage}</span>;
  }
  const tone: StageStateTone = stageStateTone(props.state);
  return (
    <StatusBadge icon={stageStateIcon(props.state)} tone={tone}>
      {props.state}
    </StatusBadge>
  );
}

function stageStateIcon(state: StageState): TablerIcon | undefined {
  if (state === "pending" || state === "queued" || state === "running")
    return IconClock;
  if (state === "blocked" || state === "canceled") return IconBan;
  return undefined;
}
