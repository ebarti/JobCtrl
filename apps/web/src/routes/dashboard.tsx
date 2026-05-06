import { createFileRoute } from "@tanstack/react-router";

import { DashboardView } from "../views/dashboard/DashboardView.js";

export const Route = createFileRoute("/dashboard")({
  component: DashboardView,
});
