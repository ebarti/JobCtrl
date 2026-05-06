import type { JSX } from "react";

import { scoreTier } from "../lib/score-tier.js";

export interface ScoreBadgeProps {
  score: number | null;
}

export function ScoreBadge({ score }: ScoreBadgeProps): JSX.Element {
  return <span className={`fit ${scoreTier(score)}`}>{score ?? "-"}</span>;
}
