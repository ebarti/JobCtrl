import type { ScoreProfileFreshness } from "@jobctrl/contracts";
import { StatusBadge } from "../../../shared/ui/status-badge.js";

export function ScoreProfileFreshnessBadge({ freshness, compact = false }: { readonly freshness?: ScoreProfileFreshness | undefined; readonly compact?: boolean }) {
  if (!freshness || freshness.status === "current" || freshness.status === "not_scored") return null;
  const label = freshness.status === "reviewed_unchanged" ? (compact ? "Changes checked" : "Profile changes checked · score retained")
    : freshness.status === "profile_updated" ? (compact ? "Profile updated" : "Profile updated since scoring")
      : compact ? "Profile unknown" : "Score profile version unknown";
  const title = freshness.review?.rationale ?? (freshness.status === "unknown"
    ? "This score has no comparable recorded profile version. Its freshness is unknown."
    : `Score used profile v${freshness.scoredProfileVersion}; saved profile is v${freshness.currentProfileVersion}. Request a score update to check whether these edits affect this job.`);
  return <StatusBadge className="score-profile-tag" tone={freshness.status === "reviewed_unchanged" ? "info" : "warn"} title={title}>{label}</StatusBadge>;
}
