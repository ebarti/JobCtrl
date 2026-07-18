import type { PolitenessOutcomeReason, SourcePolitenessOutcomes } from "@jobctrl/contracts";

// Neutral, factual labels for the three crawl-politeness outcomes. These are
// NON-error outcomes recorded by the R10 gateway (a robots.txt disallow, a
// rate-limit, or a per-run budget exhaustion), so the wording states the fact
// without implying a failure.
const POLITENESS_REASON_LABELS: Record<PolitenessOutcomeReason, string> = {
  robots_disallowed: "robots disallowed",
  rate_limited: "rate limited",
  budget_exhausted: "budget exhausted",
};

interface PolitenessBadge {
  reason: PolitenessOutcomeReason;
  label: string;
  count: number;
}

function politenessBadges(politeness: SourcePolitenessOutcomes): PolitenessBadge[] {
  const badges: PolitenessBadge[] = [];
  if (politeness.robotsDisallowedCount > 0) {
    badges.push({
      reason: "robots_disallowed",
      label: POLITENESS_REASON_LABELS.robots_disallowed,
      count: politeness.robotsDisallowedCount,
    });
  }
  if (politeness.rateLimitedCount > 0) {
    badges.push({
      reason: "rate_limited",
      label: POLITENESS_REASON_LABELS.rate_limited,
      count: politeness.rateLimitedCount,
    });
  }
  if (politeness.budgetExhaustedCount > 0) {
    badges.push({
      reason: "budget_exhausted",
      label: POLITENESS_REASON_LABELS.budget_exhausted,
      count: politeness.budgetExhaustedCount,
    });
  }
  return badges;
}

/** True when the source recorded at least one politeness outcome. */
export function hasPolitenessOutcomes(politeness: SourcePolitenessOutcomes): boolean {
  return (
    politeness.robotsDisallowedCount > 0 ||
    politeness.rateLimitedCount > 0 ||
    politeness.budgetExhaustedCount > 0
  );
}

/** Neutral labels for the recorded outcomes, e.g. for grid filtering. */
export function politenessOutcomeSummary(politeness: SourcePolitenessOutcomes): string {
  return politenessBadges(politeness)
    .map((badge) => badge.label)
    .join(" ");
}

export interface SourcePolitenessBadgesProps {
  readonly politeness: SourcePolitenessOutcomes;
  /** Accessible context (e.g. the source name) folded into each badge label. */
  readonly sourceLabel?: string;
}

/**
 * Renders one neutral badge per recorded crawl-politeness outcome. Renders
 * nothing when no outcome was recorded — an honest empty state that implies
 * nothing about the source.
 */
export function SourcePolitenessBadges({ politeness, sourceLabel }: SourcePolitenessBadgesProps) {
  const badges = politenessBadges(politeness);
  if (badges.length === 0) {
    return null;
  }
  const context = sourceLabel ? ` for ${sourceLabel}` : "";
  return (
    <span className="source-politeness-badges">
      {badges.map((badge) => {
        const times = `${badge.count} time${badge.count === 1 ? "" : "s"}`;
        return (
          <span
            key={badge.reason}
            className="source-politeness-badge"
            data-typography="label"
            title={`${badge.label}: ${times}${context}`}
          >
            {badge.label}
            <span
              className="source-politeness-badge-count"
              data-typography="metadata"
            >
              {badge.count}
            </span>
          </span>
        );
      })}
    </span>
  );
}
