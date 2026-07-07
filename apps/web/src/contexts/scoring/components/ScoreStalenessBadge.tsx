import type { ScoreStaleness } from "@jobctrl/contracts";
import type { JSX } from "react";

export interface ScoreStalenessBadgeProps {
  readonly staleness: ScoreStaleness;
}

export function ScoreStalenessBadge({ staleness }: ScoreStalenessBadgeProps): JSX.Element | null {
  if (!staleness.isStale) {
    return null;
  }
  const versionLabel =
    staleness.currentPolicyVersion !== null && staleness.targetPolicyVersion !== null
      ? `v${staleness.currentPolicyVersion} -> v${staleness.targetPolicyVersion}`
      : "policy updated";
  return (
    <span
      className="tag score-stale-tag"
      title={staleness.staleReason ?? "Score stale after scoring policy update"}
    >
      stale score {versionLabel}
    </span>
  );
}
