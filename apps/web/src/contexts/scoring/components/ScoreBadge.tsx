import type { JSX } from "react";

import { scoreTier } from "../lib/score-tier.js";

export interface ScoreBadgeProps {
  score: number | null;
}

type ScoreTone = "negative" | "neutral" | "positive" | "unknown";
function clampScore(score: number): number {
  return Math.min(10, Math.max(0, score));
}

function scoreTone(score: number | null): ScoreTone {
  if (score === null) return "unknown";
  const clamped = clampScore(score);
  if (clamped > 5) return "positive";
  if (clamped < 5) return "negative";
  return "neutral";
}

export function ScoreBadge({ score }: ScoreBadgeProps): JSX.Element {
  return (
    <span
      className={`fit ${scoreTier(score)}`}
      data-score-tone={scoreTone(score)}
      aria-label={score === null ? "Fit score unavailable" : `Fit score ${score} out of 10`}
    >
      {score ?? "-"}
    </span>
  );
}
