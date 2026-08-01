import { IconAlertTriangle } from "@tabler/icons-react";

import { OutcomeSuggestionsPanel } from "../../contexts/apply/components/ApplicationOutcomes.js";
import {
  LearningRecommendationReviewPanel,
  TailoringPolicyHistoryPanel,
} from "../../contexts/materials/index.js";
import { useApplicationOutcomesQuery } from "../../contexts/operations/hooks/useApplicationOutcomesQuery.js";
import { useDashboardSummaryQuery } from "../../contexts/operations/hooks/useDashboardSummaryQuery.js";
import { useWorkflowRunsListQuery } from "../../contexts/operations/hooks/useWorkflowRunsListQuery.js";
import { Alert, AlertDescription, AlertTitle } from "../../shared/ui/alert.js";
import { CardHeader } from "../../shared/ui/card-header.js";
import { Empty } from "../../shared/ui/empty.js";
import { PageHead } from "../../shared/ui/page-head.js";
import { ActiveRunsCard } from "./ActiveRunsCard.js";
import { ApplyRunsCard } from "./ApplyRunsCard.js";
import { ConversionPanel } from "./ConversionPanel.js";
import { DigestPanel } from "./DigestPanel.js";
import { Funnel } from "./Funnel.js";
import { KpiGrid, KpiSkeleton } from "./KpiGrid.js";
import { RecentActivityCard } from "./RecentActivityCard.js";
import { SourceHealthCard } from "./SourceHealthCard.js";
import { WorkStatusCard } from "./WorkStatusCard.js";
import { IN_PROGRESS_RUNS_INPUT, mergeActiveRuns, STARTING_RUNS_INPUT } from "./active-runs.js";

export function DashboardView() {
  const { data: summary, isLoading, error } = useDashboardSummaryQuery();
  const outcomes = useApplicationOutcomesQuery();
  const startingRuns = useWorkflowRunsListQuery(STARTING_RUNS_INPUT);
  const inProgressRuns = useWorkflowRunsListQuery(IN_PROGRESS_RUNS_INPUT);
  const message = error instanceof Error ? error.message : null;
  const outcomesError = outcomes.error instanceof Error ? outcomes.error.message : null;
  const activeRunsError =
    startingRuns.error instanceof Error
      ? startingRuns.error.message
      : inProgressRuns.error instanceof Error
        ? inProgressRuns.error.message
        : null;
  const activeRuns = mergeActiveRuns(
    startingRuns.data?.items ?? [],
    inProgressRuns.data?.items ?? [],
  );
  const pendingSuggestions = (outcomes.data?.suggestions ?? []).filter(
    (suggestion) => suggestion.status === "pending",
  );
  return (
    <div className="dashboard-view">
      <PageHead
        eyebrow="Overview"
        title="Dashboard"
        subtitle="Pipeline health, outcomes, active work, and the decisions that need attention."
      />
      {summary ? <KpiGrid summary={summary} /> : <KpiSkeleton />}
      {message ? (
        <Alert variant="destructive" className="dashboard-error-alert">
          <IconAlertTriangle aria-hidden="true" />
          <AlertTitle>Dashboard unavailable</AlertTitle>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      {outcomesError ? (
        <Alert variant="destructive" className="dashboard-error-alert">
          <IconAlertTriangle aria-hidden="true" />
          <AlertTitle>Outcome suggestions unavailable</AlertTitle>
          <AlertDescription>{outcomesError}</AlertDescription>
        </Alert>
      ) : null}
      {summary ? (
        <div className="dashboard-stack">
          <div className="dashboard-ops">
            <ConversionPanel summary={summary} />
            <DigestPanel />
            <SourceHealthCard summary={summary} />
          </div>
          <Funnel summary={summary} />
          <div className="dashboard-tail">
            <WorkStatusCard summary={summary} />
            <ActiveRunsCard
              runs={activeRuns}
              loading={startingRuns.isLoading || inProgressRuns.isLoading}
              error={activeRunsError}
            />
            <RecentActivityCard summary={summary} />
            <ApplyRunsCard summary={summary} />
            <LearningRecommendationReviewPanel />
            <TailoringPolicyHistoryPanel />
            <section className="card col-span-full">
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
    </div>
  );
}
