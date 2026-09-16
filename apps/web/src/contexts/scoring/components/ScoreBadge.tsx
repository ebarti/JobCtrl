import type { CSSProperties, JSX } from "react";

import { scoreTier } from "../lib/score-tier.js";

export interface ScoreBadgeProps {
  score: number | null;
}

type ScoreTone = "negative" | "neutral" | "positive" | "unknown";
type ScoreBadgeStyle = CSSProperties & {
  "--fit-score-bg"?: string;
  "--fit-score-border"?: string;
  "--fit-score-fg"?: string;
  "--fit-score-shadow"?: string;
};

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

function scoreBadgeStyle(score: number | null): ScoreBadgeStyle | undefined {
  const filled = score !== null && clampScore(score) > 5;
  return {
    "--fit-score-bg": filled ? "var(--primary)" : "var(--card)",
    "--fit-score-border": score === null ? "var(--border)" : "var(--primary)",
    "--fit-score-fg": filled
      ? "var(--primary-foreground)"
      : score === null ? "var(--muted-foreground)" : "var(--foreground)",
    "--fit-score-shadow": "none",
  };
}

export function ScoreBadge({ score }: ScoreBadgeProps): JSX.Element {
  return (
    <span
      className={`fit ${scoreTier(score)}`}
      data-score-tone={scoreTone(score)}
      style={scoreBadgeStyle(score)}
    >
      {score ?? "-"}
    </span>
  );
}
