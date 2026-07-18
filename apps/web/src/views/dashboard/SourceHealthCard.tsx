import { IconBan, type TablerIcon } from "@tabler/icons-react";

import { SourcePolitenessBadges } from "../../contexts/discovery/components/SourcePolitenessBadges.js";
import type { DashboardSummary } from "../../contexts/operations/types.js";
import { CardHeader } from "../../shared/ui/card-header.js";
import { Empty } from "../../shared/ui/empty.js";
import { StatusBadge } from "../../shared/ui/status-badge.js";
import type { StatusTagTone } from "../../shared/ui/status-tokens.js";

type SourceHealth = DashboardSummary["sourceHealth"][number];

function sourceHealthTone(state: SourceHealth["recommendedState"]): StatusTagTone {
  if (state === "disabled" || state === "quarantined") {
    return "danger";
  }
  if (state === "experimental") {
    return "info";
  }
  return "ok";
}

function sourceHealthIcon(
  state: SourceHealth["recommendedState"],
): TablerIcon | undefined {
  return state === "disabled" || state === "quarantined" ? IconBan : undefined;
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}

export interface SourceHealthCardProps {
  summary: DashboardSummary;
}

export function SourceHealthCard({ summary }: SourceHealthCardProps) {
  const sources = summary.sourceHealth.slice(0, 5);
  return (
    <section className="card">
      <CardHeader title="Source health" meta={`${summary.sourceHealth.length} sources`} />
      <div className="rows">
        {sources.length ? (
          sources.map((source: SourceHealth) => (
            <div key={source.sourceId} className="mini-row">
              <StatusBadge
                icon={sourceHealthIcon(source.recommendedState)}
                tone={sourceHealthTone(source.recommendedState)}
              >
                {source.recommendedState}
              </StatusBadge>
              <span className="title-stack">
                <b data-typography="strong-body">{source.sourceId}</b>
                <span data-typography="metadata">
                  active {pct(source.activeVerificationRate)} · detail{" "}
                  {pct(source.fullDescriptionSuccessRate)} · apply{" "}
                  {pct(source.applyUrlSuccessRate)} · duplicate {pct(source.duplicateRate)}
                </span>
                <SourcePolitenessBadges
                  politeness={source.politeness}
                  sourceLabel={source.sourceId}
                />
              </span>
              {source.consecutiveFailures ? (
                <StatusBadge tone="danger">{source.consecutiveFailures} fails</StatusBadge>
              ) : null}
            </div>
          ))
        ) : (
          <Empty title="No source health." />
        )}
      </div>
    </section>
  );
}
