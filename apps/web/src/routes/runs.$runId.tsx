import { createFileRoute } from "@tanstack/react-router";

import { WorkflowRunDrawer } from "../views/runs/WorkflowRunDrawer.js";

export const Route = createFileRoute("/runs/$runId")({
  component: WorkflowRunRoute,
});

function WorkflowRunRoute() {
  const { runId } = Route.useParams();
  return <WorkflowRunDrawer runId={runId} />;
}
