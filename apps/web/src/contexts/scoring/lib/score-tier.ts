export const SCORE_TIERS = ["good", "mid", "none"] as const;
export type ScoreTier = (typeof SCORE_TIERS)[number];

export function scoreTier(score: number | null): ScoreTier {
  if ((score ?? 0) >= 8) {
    return "good";
  }
  if ((score ?? 0) >= 6) {
    return "mid";
  }
  return "none";
}
