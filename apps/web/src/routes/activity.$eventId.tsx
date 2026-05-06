import type { DashboardSummary } from "@jobhunter/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { ActivityDetailDrawer } from "../views/dashboard/ActivityDetailDrawer.js";

type ActivityEvent = DashboardSummary["activity"][number];

export const Route = createFileRoute("/activity/$eventId")({
  loader: async ({ params, context }): Promise<{ activity: ActivityEvent | null }> => {
    const summary = await context.ports.api.dashboardSummary();
    const activity =
      summary.activity.find((entry: ActivityEvent) => entry.eventId === params.eventId) ?? null;
    if (activity?.jobKey) {
      throw redirect({
        to: "/jobs/$jobId",
        params: { jobId: activity.jobKey },
        replace: true,
      });
    }
    return { activity };
  },
  component: ActivityRoute,
});

function ActivityRoute() {
  const { activity } = Route.useLoaderData();
  const { eventId } = Route.useParams();
  return <ActivityDetailDrawer eventId={eventId} activity={activity} />;
}
