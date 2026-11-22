import { IconBan } from "@tabler/icons-react";
import type { SourceRegistryEntrySummary } from "@jobctrl/contracts";
import { CardHeader } from "../../../shared/ui/card-header.js";
import { Empty } from "../../../shared/ui/empty.js";
import { StatusBadge } from "../../../shared/ui/status-badge.js";
import { useSourceRegistryQuery } from "../hooks/useDiscoveryProductControlsQuery.js";
import { SourcePolitenessBadges } from "./SourcePolitenessBadges.js";

function pct(value: number | null): string { return value === null ? "n/a" : `${Math.round(value * 100)}%`; }

export function DiscoverySourceHealthPanel() {
  const query = useSourceRegistryQuery();
  const sources = query.data?.sources ?? [];
  return <section className="card">
    <CardHeader title="Source health" meta={query.data ? `${sources.length} sources` : "loading"} />
    {query.error ? <p role="alert">Source health could not be refreshed.{query.data ? " The last loaded source data remains below." : ""}</p> : null}
    <div className="rows">
      {query.isPending ? <Empty title="Loading source health." /> : null}
      {!query.isPending && query.data && !sources.length ? <Empty title="No source health." /> : null}
      {sources.slice(0, 5).map((source: SourceRegistryEntrySummary) => {
        const blocked = source.recommendedState === "disabled" || source.recommendedState === "quarantined";
        return <div key={source.sourceId} className="mini-row">
          <StatusBadge icon={blocked ? IconBan : undefined} tone={blocked ? "danger" : source.recommendedState === "experimental" ? "info" : "ok"}>{source.recommendedState}</StatusBadge>
          <span className="title-stack"><b data-typography="strong-body">{source.displayName ?? source.sourceId}</b>
            <span className="source-health-primary" data-typography="metadata">{pct(source.activeVerificationRate)} active · {pct(source.applyUrlSuccessRate)} apply</span>
            <span className="source-health-secondary" data-typography="metadata">{pct(source.fullDescriptionSuccessRate)} full detail · {pct(source.duplicateRate)} duplicates</span>
            <SourcePolitenessBadges politeness={source.politeness} sourceLabel={source.displayName ?? source.sourceId} />
          </span>
          {source.consecutiveFailures ? <StatusBadge tone="danger">{source.consecutiveFailures} fails</StatusBadge> : null}
        </div>;
      })}
    </div>
  </section>;
}
