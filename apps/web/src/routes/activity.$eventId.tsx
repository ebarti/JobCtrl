import { createFileRoute, redirect } from "@tanstack/react-router";

import { activityKeys } from "../contexts/operations/activityKeys.js";
import { ActivityDetailDrawer } from "../views/debug/ActivityDetailDrawer.js";

export const Route = createFileRoute("/activity/$eventId")({
  loader: async ({ params, context }): Promise<void> => {
    const event = await context.queryClient.ensureQueryData({
      queryKey: activityKeys.detail(context.tenantId, params.eventId),
      queryFn: async () => {
        const response = await context.ports.api.activityEvent(params.eventId);
        return response.event;
      },
    });
    const directDetail = context.ports.featureFlags.get(
      "activityDetailDirectLoad",
      false,
    );
    if (event.jobKey && !directDetail) {
      throw redirect({
        to: "/jobs/$jobId",
        params: { jobId: event.jobKey },
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
