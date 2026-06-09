/**
 * Shared formatting helpers for the materials audit inspector surfaces
 * (EmployerAnalysisPanel, BulletProvenanceList, TailoringExplanationSection).
 * Centralised so the panels render snake_case enum tokens, weights, and percents
 * identically.
 */

/** Humanise a snake/kebab token ("must_have" → "Must Have"). */
export function formatToken(value: string | null | undefined): string {
  if (!value) return "-";
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Render a 0..1 weight as a percent ("0.8" → "80%"); "-" when absent. */
export function weightPercent(weight: number | null | undefined): string {
  if (weight === null || weight === undefined || Number.isNaN(weight)) return "-";
  const clamped = Math.max(0, Math.min(1, weight));
  return `${Math.round(clamped * 100)}%`;
}

/** Render a 0..1 agreement/score as a percent; "-" when absent. */
export function scorePercent(score: number | null | undefined): string {
  if (score === null || score === undefined || Number.isNaN(score)) return "-";
  return `${Math.round(score * 100)}%`;
}
