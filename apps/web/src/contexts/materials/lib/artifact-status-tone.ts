import type { StatusTagTone } from "../../../shared/ui/status-tokens.js";

export type ArtifactStatusTone = StatusTagTone;

export function artifactStatusTone(status: string): ArtifactStatusTone {
  if (status === "active" || status === "approved") {
    return "ok";
  }
  if (status === "missing" || status === "stale") {
    return "warn";
  }
  if (status === "rejected") {
    return "danger";
  }
  return "muted";
}
