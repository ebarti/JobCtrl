import type { ReactNode } from "react";
import type { PreparationRecipe } from "../client.js";
import { PipelineRecipePanel } from "./PreparationControls.js";

export interface StageTriggerPanelProps {
  readonly stagePanels?: Partial<Record<string, ReactNode>>;
  readonly stageRunBlockReasons?: Partial<Record<PreparationRecipe, ReactNode>>;
}

export function StageTriggerPanel({ stageRunBlockReasons }: StageTriggerPanelProps = {}) {
  return <PipelineRecipePanel {...(stageRunBlockReasons ? { stageRunBlockReasons } : {})} />;
}
