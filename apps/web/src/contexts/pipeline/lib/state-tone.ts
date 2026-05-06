export function stateTone(state: string): string {
  if (["failed", "exhausted"].includes(state)) {
    return "danger";
  }
  if (state === "blocked") {
    return "warn";
  }
  if (state === "succeeded") {
    return "ok";
  }
  return "muted";
}
