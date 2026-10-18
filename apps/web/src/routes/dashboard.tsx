import { prefetchDashboard } from "../contexts/operations/readQueries.js";
import { createFileRoute } from "@tanstack/react-router";

import { DashboardView } from "../views/dashboard/DashboardView.js";

export const Route = createFileRoute("/dashboard")({
  loader: ({ context }) => prefetchDashboard(context),
  component: DashboardView,
});
