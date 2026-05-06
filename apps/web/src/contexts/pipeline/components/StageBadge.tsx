import type { JSX } from "react";

import type { Stage, StageState } from "../../operations/types.js";
import { stageStateTone, type StageStateTone } from "../lib/stage-state-tone.js";
import { stageTone, type StageTone } from "../lib/stage-tone.js";

export type StageBadgeProps = { stage: Stage } | { state: StageState };

export function StageBadge(props: StageBadgeProps): JSX.Element {
  if ("stage" in props) {
    const tone: StageTone = stageTone(props.stage);
    return <span className={`stage-pill ${tone}`}>{props.stage}</span>;
  }
  const tone: StageStateTone = stageStateTone(props.state);
  return <span className={`tag ${tone}`}>{props.state}</span>;
}
