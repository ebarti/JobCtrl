export function artifactStatusTone(status: string): string {
  if (status === "active" || status === "approved") {
    return "ok";
  }
  if (status === "missing" || status === "stale") {
    return "warn";
  }
  return "muted";
}
