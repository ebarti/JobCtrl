import { OutcomeSuggestionsPanel } from "../../contexts/apply/components/ApplicationOutcomes.js";
import { useApplicationOutcomesQuery } from "../../contexts/operations/hooks/useApplicationOutcomesQuery.js";
import { useDashboardSummaryQuery } from "../../contexts/operations/hooks/useDashboardSummaryQuery.js";
import { CardHeader } from "../../shared/ui/card-header.js";
import { Empty } from "../../shared/ui/empty.js";
import { PageHead } from "../../shared/ui/page-head.js";
import { ApplyRunsCard } from "./ApplyRunsCard.js";
import { ConversionPanel } from "./ConversionPanel.js";
import { DigestPanel } from "./DigestPanel.js";
import { Funnel } from "./Funnel.js";
import { KpiGrid, KpiSkeleton } from "./KpiGrid.js";
import { SourceHealthCard } from "./SourceHealthCard.js";

export function DashboardView() {
  const { data: summary, isLoading, error } = useDashboardSummaryQuery();
  const outcomes = useApplicationOutcomesQuery();
  const message = error instanceof Error ? error.message : null;
  const outcomesError = outcomes.error instanceof Error ? outcomes.error.message : null;
  const pendingSuggestions = (outcomes.data?.suggestions ?? []).filter(
    (suggestion) => suggestion.status === "pending",
  );
  return (
    <>
      <PageHead eyebrow="Overview" title="Dashboard" />
      {summary ? <KpiGrid summary={summary} /> : <KpiSkeleton />}
      {message ? <div className="banner">{message}</div> : null}
      {outcomesError ? <div className="banner">{outcomesError}</div> : null}
      {summary ? (
        <div className="dashboard-stack">
          <div className="dashboard-ops">
            <ConversionPanel summary={summary} />
            <DigestPanel />
            <SourceHealthCard summary={summary} />
          </div>
          <Funnel summary={summary} />
          <div className="dashboard-tail">
            <ApplyRunsCard summary={summary} />
            <section className="card">
              <CardHeader
                title="Outcome suggestions"
                meta={outcomes.data ? `${pendingSuggestions.length} pending` : "loading"}
              />
              {outcomes.isFetching && !outcomes.data ? (
                <Empty title="Loading outcome suggestions." />
              ) : null}
              {outcomes.data ? <OutcomeSuggestionsPanel suggestions={pendingSuggestions} /> : null}
            </section>
          </div>
        </div>
      ) : (
        <Empty title={isLoading ? "Loading dashboard." : "No dashboard data."} />
      )}
    </>
  );
}
