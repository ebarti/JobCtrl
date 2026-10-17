import { createFileRoute, Outlet } from "@tanstack/react-router";

import { jobsSearchSchema } from "./-jobs.search.js";

export const Route = createFileRoute("/jobs")({
  validateSearch: (search) => jobsSearchSchema.parse(search),
  // JobsView owns fetching because the effective query also includes grid and
  // saved-view stage selections, which are not represented by scalar URL links.
  component: Outlet,
});
