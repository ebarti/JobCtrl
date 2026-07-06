import { createFileRoute } from "@tanstack/react-router";

import { dashboardKeys } from "../contexts/operations/dashboardKeys.js";
import { digestKeys } from "../contexts/operations/digestKeys.js";
import { outcomesKeys } from "../contexts/operations/outcomesKeys.js";
import { DashboardView } from "../views/dashboard/DashboardView.js";

export const Route = createFileRoute("/dashboard")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData({
      queryKey: dashboardKeys.summary(context.tenantId),
      queryFn: () => context.ports.api.dashboardSummary(),
    });
    await context.queryClient
      .ensureQueryData({
        queryKey: outcomesKeys.list(context.tenantId),
        queryFn: () => context.ports.api.applicationOutcomes(),
      })
      .catch(() => undefined);
    await context.queryClient
      .ensureQueryData({
        queryKey: digestKeys.summary(context.tenantId),
        queryFn: () => context.ports.api.digest(),
      })
      .catch(() => undefined);
  },
  component: DashboardView,
});
