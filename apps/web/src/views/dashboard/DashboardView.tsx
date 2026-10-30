import { IconAlertTriangle } from "@tabler/icons-react";

import { OutcomeSuggestionsPanel } from "../../contexts/apply/components/ApplicationOutcomes.js";
import {
  LearningRecommendationReviewPanel,
  TailoringPolicyHistoryPanel,
} from "../../contexts/materials/index.js";
import { useApplicationOutcomesQuery } from "../../contexts/operations/hooks/useApplicationOutcomesQuery.js";
import { useDashboardSummaryQuery } from "../../contexts/operations/hooks/useDashboardSummaryQuery.js";
import { useWorkflowRunsListQuery } from "../../contexts/operations/hooks/useWorkflowRunsListQuery.js";
import { getApiCapabilityAvailability, LOCAL_INSTALL_GUIDE_URL } from "../../shared/lib/apiCapabilityAvailability.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
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
import { mergeActiveRuns } from "./active-runs.js";
import {
  IN_PROGRESS_RUNS_INPUT,
  STARTING_RUNS_INPUT,
} from "../../contexts/operations/activeRuns.js";

export function DashboardView() {
  const { featureFlags } = usePorts();
  const learningAvailability = getApiCapabilityAvailability(featureFlags, "learningRecommendations");
  const policyHistoryAvailability = getApiCapabilityAvailability(featureFlags, "tailoringPolicyRevisions");
  const { data: summary, isLoading, error } = useDashboardSummaryQuery();
  const outcomes = useApplicationOutcomesQuery();
  const startingRuns = useWorkflowRunsListQuery(STARTING_RUNS_INPUT);
  const inProgressRuns = useWorkflowRunsListQuery(IN_PROGRESS_RUNS_INPUT);
  const message = error instanceof Error ? error.message : null;
  const outcomesError =
    outcomes.error instanceof Error ? outcomes.error.message : null;
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
            {learningAvailability.available ? (
              <LearningRecommendationReviewPanel />
            ) : (
              <LocalAppFeatureCard title="Learning recommendations" reason={learningAvailability.reason} />
            )}
            {policyHistoryAvailability.available ? (
              <TailoringPolicyHistoryPanel />
            ) : (
              <LocalAppFeatureCard title="Tailoring policy history" reason={policyHistoryAvailability.reason} />
            )}
            <section className="card col-span-full">
              <CardHeader
                title="Outcome suggestions"
                meta={
                  outcomes.data
                    ? `${pendingSuggestions.length} pending`
                    : "loading"
                }
              />
              {outcomes.isFetching && !outcomes.data ? (
                <Empty title="Loading outcome suggestions." />
              ) : null}
              {outcomes.data ? (
                <OutcomeSuggestionsPanel
                  suggestions={pendingSuggestions}
                  interpretationStatus={outcomes.data.interpretationStatus}
                />
              ) : null}
            </section>
          </div>
        </div>
      ) : (
        <Empty
          title={isLoading ? "Loading dashboard." : "No dashboard data."}
        />
      )}
    </div>
  );
}

function LocalAppFeatureCard({ title, reason }: { title: string; reason: string | null }) {
  return (
    <section className="card col-span-full">
      <CardHeader title={title} meta="Local app" />
      <p className="px-4 py-3">
        <span>{reason}</span> <a href={LOCAL_INSTALL_GUIDE_URL}>Install JobCtrl</a> to use this feature.
      </p>
    </section>
  );
}
