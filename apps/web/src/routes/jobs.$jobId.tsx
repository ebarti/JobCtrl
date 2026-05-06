import { createFileRoute } from "@tanstack/react-router";

import { JobDetailDrawer } from "../views/jobs/JobDetailDrawer.js";

export const Route = createFileRoute("/jobs/$jobId")({
  component: JobDrawerRoute,
});

function JobDrawerRoute() {
  const { jobId } = Route.useParams();
  return <JobDetailDrawer jobId={jobId} />;
}
