import { createFileRoute } from "@tanstack/react-router";

import { ActionRunDetail, ensureActionRun } from "../contexts/runs/index.js";
import { PreparationRunDetail } from "../contexts/pipeline/index.js";

export const Route = createFileRoute("/runs/$runId")({
  loader: ({ context, params }) => ensureActionRun(context, params.runId),
  component: RunRoute,
});

function RunRoute() {
  const { runId } = Route.useParams();
  return <ActionRunDetail runId={runId} renderFeatureDetail={(run) =>
    run.action.startsWith("preparation.") && !["pending", "queued", "start_failed"].includes(run.status)
      ? <PreparationRunDetail runId={runId} /> : null} />;
}
