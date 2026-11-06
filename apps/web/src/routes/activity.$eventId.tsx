import { createFileRoute } from "@tanstack/react-router";

import { ActivityEventPage, ensureActivityEvent } from "../contexts/activity/index.js";

export const Route = createFileRoute("/activity/$eventId")({
  loader: ({ context, params }) => ensureActivityEvent(context, params.eventId),
  component: ActivityRoute,
});

function ActivityRoute() {
  const { eventId } = Route.useParams();
  return <ActivityEventPage eventId={eventId} />;
}
