import type { DashboardSummary } from "../../contexts/operations/types.js";
import { CardHeader } from "../../shared/ui/card-header.js";
import { Empty } from "../../shared/ui/empty.js";
import { StatusDot } from "../../shared/ui/status-dot.js";

type SourceHealth = DashboardSummary["sourceHealth"][number];

function dotState(state: string): string {
  if (state === "disabled" || state === "quarantined") {
    return "failed";
  }
  if (state === "experimental") {
    return "running";
  }
  return "succeeded";
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
              <StatusDot state={dotState(source.recommendedState)} />
              <span className="title-stack">
                <b>{source.sourceId}</b>
                <span>
                  active {pct(source.activeVerificationRate)} · detail{" "}
                  {pct(source.fullDescriptionSuccessRate)} · apply{" "}
                  {pct(source.applyUrlSuccessRate)} · duplicate {pct(source.duplicateRate)}
                </span>
              </span>
              {source.consecutiveFailures ? (
                <span className="tag danger">{source.consecutiveFailures} fails</span>
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
