import type { StageState } from "../../operations/types.js";
import { stageStateTone, type StageStateTone } from "./stage-state-tone.js";

export function stateTone(state: StageState): StageStateTone {
  return stageStateTone(state);
}
