import { ensureActivityEvent } from "../contexts/operations/readQueries.js";
import { createFileRoute } from "@tanstack/react-router";

import { ActivityDetailDrawer } from "../views/debug/ActivityDetailDrawer.js";

export const Route = createFileRoute("/activity/$eventId")({
  loader: ({ context, params }) => ensureActivityEvent(context, params.eventId),
  component: ActivityRoute,
});

function ActivityRoute() {
  const { eventId } = Route.useParams();
  return <ActivityDetailDrawer eventId={eventId} />;
}
