import { useDashboardSummaryQuery } from "../../contexts/operations/hooks/useDashboardSummaryQuery.js";
import { Empty } from "../../shared/ui/empty.js";
import { ApplyRunsCard } from "./ApplyRunsCard.js";
import { Funnel } from "./Funnel.js";
import { KpiGrid, KpiSkeleton } from "./KpiGrid.js";
import { SourceHealthCard } from "./SourceHealthCard.js";

export function DashboardView() {
  const { data: summary, isLoading, error } = useDashboardSummaryQuery();
  const message = error instanceof Error ? error.message : null;
  return (
    <>
      {summary ? <KpiGrid summary={summary} /> : <KpiSkeleton />}
      {message ? <div className="banner">{message}</div> : null}
      {summary ? (
        <div className="dashboard-grid">
          <Funnel summary={summary} />
          <SourceHealthCard summary={summary} />
          <ApplyRunsCard summary={summary} />
        </div>
      ) : (
        <Empty title={isLoading ? "Loading dashboard." : "No dashboard data."} />
      )}
    </>
  );
}
