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
  if (score === null) return undefined;
  const clamped = clampScore(score);
  if (clamped === 5) {
    return {
      "--fit-score-bg": "var(--muted)",
      "--fit-score-border": "var(--border)",
      "--fit-score-fg": "var(--muted-foreground)",
      "--fit-score-shadow": "none",
    };
  }

  const token = clamped > 5 ? "var(--success)" : "var(--destructive)";
  const distance = Math.abs(clamped - 5) / 5;
  const fill = Math.round(12 + distance * 40);
  const border = Math.round(24 + distance * 42);

  return {
    "--fit-score-bg": `color-mix(in oklab, ${token} ${fill}%, var(--card))`,
    "--fit-score-border": `color-mix(in oklab, ${token} ${border}%, var(--border))`,
    "--fit-score-fg": "var(--foreground)",
    "--fit-score-shadow": `inset 0 0 0 1px color-mix(in oklab, ${token} ${Math.min(border, 64)}%, transparent)`,
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
