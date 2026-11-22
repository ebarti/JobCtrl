import { createFileRoute } from "@tanstack/react-router";

import { prefetchResumeArtifactDetail } from "../contexts/resumes/index.js";
import { ArtifactDetailPanel } from "../views/artifacts/ArtifactDetailPanel.js";

export const Route = createFileRoute("/artifacts/$artifactId")({
  loader: ({ context, params }) =>
    prefetchResumeArtifactDetail(context, params.artifactId),
  component: ArtifactDetailRoute,
});
function ArtifactDetailRoute() {
  const { artifactId } = Route.useParams();
  return <ArtifactDetailPanel artifactId={artifactId} />;
}
