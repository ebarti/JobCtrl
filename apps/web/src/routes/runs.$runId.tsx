import { createFileRoute } from "@tanstack/react-router";

import { ApplyRunDrawer } from "../views/dashboard/ApplyRunDrawer.js";

export const Route = createFileRoute("/runs/$runId")({
  component: ApplyRunRoute,
});

function ApplyRunRoute() {
  const { runId } = Route.useParams();
  return <ApplyRunDrawer runId={runId} />;
}
