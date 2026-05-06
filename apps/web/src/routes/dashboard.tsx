import { createFileRoute } from "@tanstack/react-router";

import { dashboardKeys } from "../contexts/operations/dashboardKeys.js";
import { DashboardView } from "../views/dashboard/DashboardView.js";

export const Route = createFileRoute("/dashboard")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData({
      queryKey: dashboardKeys.summary(context.tenantId),
      queryFn: () => context.ports.api.dashboardSummary(),
    }),
  component: DashboardView,
});
