import { createFileRoute } from "@tanstack/react-router";

import { activityKeys } from "../contexts/operations/activityKeys.js";
import { ActivityDetailDrawer } from "../views/debug/ActivityDetailDrawer.js";

export const Route = createFileRoute("/activity/$eventId")({
  loader: async ({ params, context }): Promise<void> => {
    await context.queryClient.ensureQueryData({
      queryKey: activityKeys.detail(context.tenantId, params.eventId),
      queryFn: async () => {
        const response = await context.ports.api.activityEvent(params.eventId);
        return response.event;
      },
    });
  },
  component: ActivityRoute,
});

function ActivityRoute() {
  const { eventId } = Route.useParams();
  return <ActivityDetailDrawer eventId={eventId} />;
}
