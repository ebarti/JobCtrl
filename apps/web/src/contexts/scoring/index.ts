export { scoringKeys } from "./queryKeys.js";

export { useCorrectScoreMutation } from "./hooks/useCorrectScoreMutation.js";
export { useResetStaleScoresForRescoreMutation } from "./hooks/useResetStaleScoresForRescoreMutation.js";
export { useUpdateCompensationSourcePolicyMutation } from "./hooks/useUpdateCompensationSourcePolicyMutation.js";
export {
  useRescoreCurrentPolicyMutation,
  useRescoreJobMutation,
  type RescoreCurrentPolicyVariables,
  type RescoreJobVariables,
} from "./hooks/useRescoreCurrentPolicyMutation.js";

export { ScoreBadge, type ScoreBadgeProps } from "./components/ScoreBadge.js";
export { ScoreBreakdown, type ScoreBreakdownProps } from "./components/ScoreBreakdown.js";
export { ScoreCorrectionControl, type ScoreCorrectionControlProps } from "./components/ScoreCorrectionControl.js";
export { ResetStaleScoresButton, type ResetStaleScoresButtonProps } from "./components/ResetStaleScoresButton.js";
export {
  RescoreCurrentPolicyButton,
  RescoreJobButton,
  type RescoreCurrentPolicyButtonProps,
  type RescoreJobButtonProps,
} from "./components/RescoreCurrentPolicyButton.js";
export { ScoreStalenessBadge, type ScoreStalenessBadgeProps } from "./components/ScoreStalenessBadge.js";
export { ScoreReasoning } from "./components/ScoreReasoning.js";
export { CompensationSourcePolicyPanel } from "./components/CompensationSourcePolicyPanel.js";
export { scoreTier } from "./lib/score-tier.js";

export { jobScoredHandler, scoreCorrectedHandler, scoreRescoreRequestedHandler } from "./handlers.js";
