import type { StatusTagTone } from "../../shared/ui/status-tokens.js";

export function activityLevelTone(level: string): StatusTagTone {
  const normalized = level.trim().toLowerCase();
  if (normalized === "error") return "danger";
  if (normalized === "warn" || normalized === "warning") return "warn";
  if (normalized === "info") return "info";
  return "muted";
}

