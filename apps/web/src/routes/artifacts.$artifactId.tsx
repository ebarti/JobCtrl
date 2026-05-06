import { createFileRoute } from "@tanstack/react-router";

import { ArtifactDetailPanel } from "../views/artifacts/ArtifactDetailPanel.js";

export const Route = createFileRoute("/artifacts/$artifactId")({
  component: ArtifactDetailRoute,
});

function ArtifactDetailRoute() {
  const { artifactId } = Route.useParams();
  return <ArtifactDetailPanel artifactId={artifactId} />;
}
