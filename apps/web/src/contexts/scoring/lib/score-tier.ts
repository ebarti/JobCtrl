export function scoreTier(score: number | null): string {
  if ((score ?? 0) >= 8) {
    return "good";
  }
  if ((score ?? 0) >= 6) {
    return "mid";
  }
  return "none";
}
