import { createFileRoute } from "@tanstack/react-router";

import { dashboardKeys } from "../contexts/operations/dashboardKeys.js";
import { digestKeys } from "../contexts/operations/digestKeys.js";
import { outcomesKeys } from "../contexts/operations/outcomesKeys.js";
import { workflowRunsKeys } from "../contexts/operations/workflowRunsKeys.js";
import { IN_PROGRESS_RUNS_INPUT, STARTING_RUNS_INPUT } from "../views/dashboard/active-runs.js";
import { DashboardView } from "../views/dashboard/DashboardView.js";

export const Route = createFileRoute("/dashboard")({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.prefetchQuery({
        queryKey: dashboardKeys.summary(context.tenantId),
        queryFn: () => context.ports.api.dashboardSummary(),
      }),
      context.queryClient.prefetchQuery({
        queryKey: outcomesKeys.list(context.tenantId),
        queryFn: () => context.ports.api.applicationOutcomes(),
      }).catch(() => undefined),
      context.queryClient.prefetchQuery({
        queryKey: digestKeys.summary(context.tenantId),
        queryFn: () => context.ports.api.digest(),
      }).catch(() => undefined),
      context.queryClient.prefetchQuery({
        queryKey: workflowRunsKeys.list(context.tenantId, STARTING_RUNS_INPUT),
        queryFn: () => context.ports.api.workflowRuns(STARTING_RUNS_INPUT),
      }).catch(() => undefined),
      context.queryClient.prefetchQuery({
        queryKey: workflowRunsKeys.list(context.tenantId, IN_PROGRESS_RUNS_INPUT),
        queryFn: () => context.ports.api.workflowRuns(IN_PROGRESS_RUNS_INPUT),
      }).catch(() => undefined),
    ]);
  },
  component: DashboardView,
});
