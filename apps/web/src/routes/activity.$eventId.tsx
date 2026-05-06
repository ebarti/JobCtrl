import { createFileRoute, redirect } from "@tanstack/react-router";

import { dashboardKeys } from "../contexts/operations/dashboardKeys.js";
import type { DashboardSummary } from "../contexts/operations/types.js";
import { ActivityDetailDrawer } from "../views/dashboard/ActivityDetailDrawer.js";

type ActivityEvent = DashboardSummary["activity"][number];

export const Route = createFileRoute("/activity/$eventId")({
  loader: async ({ params, context }): Promise<void> => {
    const summary = await context.queryClient.ensureQueryData<DashboardSummary>({
      queryKey: dashboardKeys.summary(context.tenantId),
      queryFn: () => context.ports.api.dashboardSummary(),
    });
    const activity =
      summary.activity.find((entry: ActivityEvent) => entry.eventId === params.eventId) ?? null;
    if (activity?.jobKey) {
      throw redirect({
        to: "/jobs/$jobId",
        params: { jobId: activity.jobKey },
        replace: true,
      });
    }
  },
  component: ActivityRoute,
});

function ActivityRoute() {
  const { eventId } = Route.useParams();
  return <ActivityDetailDrawer eventId={eventId} />;
}
