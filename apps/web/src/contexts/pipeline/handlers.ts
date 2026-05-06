import type {
  StageBlocked,
  StageCanceled,
  StageCompleted,
  StageExhausted,
  StageFailed,
  StageReset,
  StageSkipped,
  StageStarted,
} from "@jobhunter/domain-types";

import type { InvalidationItem } from "../operations/invalidation-router.js";

export const stageStartedHandler = (_event: StageStarted): readonly InvalidationItem[] => [];
export const stageCompletedHandler = (
  _event: StageCompleted,
): readonly InvalidationItem[] => [];
export const stageFailedHandler = (_event: StageFailed): readonly InvalidationItem[] => [];
export const stageExhaustedHandler = (
  _event: StageExhausted,
): readonly InvalidationItem[] => [];
export const stageResetHandler = (_event: StageReset): readonly InvalidationItem[] => [];
export const stageBlockedHandler = (_event: StageBlocked): readonly InvalidationItem[] => [];
export const stageSkippedHandler = (_event: StageSkipped): readonly InvalidationItem[] => [];
export const stageCanceledHandler = (
  _event: StageCanceled,
): readonly InvalidationItem[] => [];
