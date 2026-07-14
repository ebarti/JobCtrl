import type { ScoreStaleness } from "@jobctrl/contracts";
import type { JSX } from "react";

import { StatusLabel } from "../../../shared/ui/status-label.js";

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
    <StatusLabel
      className="score-stale-tag"
      title={staleness.staleReason ?? "Score stale after scoring policy update"}
      tone="warn"
    >
      stale score {versionLabel}
    </StatusLabel>
  );
}
