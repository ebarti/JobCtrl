import { STARTING_RUNS_INPUT, IN_PROGRESS_RUNS_INPUT } from "./activeRuns.js";
import { dashboardKeys } from "./dashboardKeys.js";
import { outcomesKeys } from "./outcomesKeys.js";
import { digestKeys } from "./digestKeys.js";
import { activityKeys } from "./activityKeys.js";
import type { ActivityListInput } from "./types.js";
import { workflowRunsKeys } from "./workflowRunsKeys.js";
import type { WorkflowRunsListInput } from "./types.js";
import { artifactsKeys } from "./artifactsKeys.js";
import type { ArtifactsListInput } from "./types.js";
import { evidenceMapKeys } from "./evidenceMapKeys.js";
import { analyticsKeys } from "./analyticsKeys.js";
import type { OutcomeAnalyticsFilters } from "./analyticsKeys.js";
import { applyReviewKeys } from "./applyReviewKeys.js";
import type {
  ReadContext,
  LoaderReadContext,
} from "../../shared/lib/loaderReadContext.js";

export function dashboardSummaryQuery(
  context: ReadContext<"dashboardSummary">,
) {
  return {
    queryKey: dashboardKeys.summary(context.tenantId),
    queryFn: () => context.ports.api.dashboardSummary(),
  };
}
export function prefetchDashboardSummary(
  context: LoaderReadContext<"dashboardSummary">,
) {
  return context.queryClient.prefetchQuery(dashboardSummaryQuery(context));
}

export function applicationOutcomesQuery(
  context: ReadContext<"applicationOutcomes">,
) {
  return {
    queryKey: outcomesKeys.list(context.tenantId),
    queryFn: () => context.ports.api.applicationOutcomes(),
  };
}
export function prefetchApplicationOutcomes(
  context: LoaderReadContext<"applicationOutcomes">,
) {
  return context.queryClient.prefetchQuery(applicationOutcomesQuery(context));
}

export function digestQuery(context: ReadContext<"digest">) {
  return {
    queryKey: digestKeys.summary(context.tenantId),
    queryFn: () => context.ports.api.digest(),
  };
}
export function prefetchDigest(context: LoaderReadContext<"digest">) {
  return context.queryClient.prefetchQuery(digestQuery(context));
}

export function activityListQuery(
  context: ReadContext<"activity">,
  input: ActivityListInput,
) {
  return {
    queryKey: activityKeys.list(context.tenantId, input),
    queryFn: () => context.ports.api.activity(input),
  };
}
export function prefetchActivityList(
  context: LoaderReadContext<"activity">,
  input: ActivityListInput,
) {
  return context.queryClient.prefetchQuery(activityListQuery(context, input));
}

export function workflowRunsListQuery(
  context: ReadContext<"workflowRuns">,
  input: WorkflowRunsListInput,
) {
  return {
    queryKey: workflowRunsKeys.list(context.tenantId, input),
    queryFn: () => context.ports.api.workflowRuns(input),
  };
}
export function prefetchWorkflowRunsList(
  context: LoaderReadContext<"workflowRuns">,
  input: WorkflowRunsListInput,
) {
  return context.queryClient.prefetchQuery(
    workflowRunsListQuery(context, input),
  );
}

export function artifactsListQuery(
  context: ReadContext<"artifacts">,
  input: ArtifactsListInput,
) {
  return {
    queryKey: artifactsKeys.list(context.tenantId, input),
    queryFn: () => context.ports.api.artifacts(input),
  };
}
export function prefetchArtifactsList(
  context: LoaderReadContext<"artifacts">,
  input: ArtifactsListInput,
) {
  return context.queryClient.prefetchQuery(artifactsListQuery(context, input));
}

export function evidenceMapQuery(context: ReadContext<"evidenceMap">) {
  return {
    queryKey: evidenceMapKeys.list(context.tenantId),
    queryFn: () => context.ports.api.evidenceMap(),
  };
}
export function prefetchEvidenceMap(context: LoaderReadContext<"evidenceMap">) {
  return context.queryClient.prefetchQuery(evidenceMapQuery(context));
}

export function outcomeAnalyticsQuery(
  context: ReadContext<"outcomeAnalytics">,
  input: OutcomeAnalyticsFilters,
) {
  return {
    queryKey: analyticsKeys.outcomes(context.tenantId, input),
    queryFn: () => context.ports.api.outcomeAnalytics(),
  };
}
export function prefetchOutcomeAnalytics(
  context: LoaderReadContext<"outcomeAnalytics">,
  input: OutcomeAnalyticsFilters,
) {
  return context.queryClient.prefetchQuery(
    outcomeAnalyticsQuery(context, input),
  );
}

export function applyReviewQueueQuery(
  context: ReadContext<"applyReviewQueue">,
) {
  return {
    queryKey: applyReviewKeys.queue(context.tenantId),
    queryFn: () => context.ports.api.applyReviewQueue(),
  };
}
export function prefetchApplyReviewQueue(
  context: LoaderReadContext<"applyReviewQueue">,
) {
  return context.queryClient.prefetchQuery(applyReviewQueueQuery(context));
}

// Activity's loader intentionally propagates 404/network failures; the hook's
// not-found-to-null policy remains an observer concern.
export async function ensureActivityEvent(
  context: LoaderReadContext<"activityEvent">,
  eventId: string,
): Promise<void> {
  await context.queryClient.ensureQueryData({
    queryKey: activityKeys.detail(context.tenantId, eventId),
    queryFn: async () => (await context.ports.api.activityEvent(eventId)).event,
  });
}

export async function prefetchDashboard(
  context: LoaderReadContext<
    "dashboardSummary" | "applicationOutcomes" | "digest" | "workflowRuns"
  >,
): Promise<void> {
  await Promise.all([
    prefetchDashboardSummary(context),
    prefetchApplicationOutcomes(context).catch(() => undefined),
    prefetchDigest(context).catch(() => undefined),
    prefetchWorkflowRunsList(context, STARTING_RUNS_INPUT).catch(
      () => undefined,
    ),
    prefetchWorkflowRunsList(context, IN_PROGRESS_RUNS_INPUT).catch(
      () => undefined,
    ),
  ]);
}
