import { createFileRoute } from "@tanstack/react-router";

import { JobsView } from "../views/jobs/JobsView.js";
import { jobsSearchSchema } from "./-jobs.search.js";

export const Route = createFileRoute("/jobs")({
  validateSearch: (search) => jobsSearchSchema.parse(search),
  component: JobsView,
});
