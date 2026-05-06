import { createFileRoute } from "@tanstack/react-router";

import { ApplyRunTimeline } from "../views/dashboard/ApplyRunTimeline.js";

export const Route = createFileRoute("/jobs/$jobId/run/$runId")({
  component: JobRunTimelineRoute,
});

function JobRunTimelineRoute() {
  const { runId } = Route.useParams();
  return <ApplyRunTimeline runId={runId} />;
}
