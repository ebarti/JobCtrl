import { createFileRoute, Outlet } from "@tanstack/react-router";

import { runsSearchSchema } from "./-runs.search.js";

export const Route = createFileRoute("/runs")({
  validateSearch: (search) => runsSearchSchema.parse(search),
  component: Outlet,
});
