import { createFileRoute } from "@tanstack/react-router";

import { ArtifactsView } from "../views/artifacts/ArtifactsView.js";

export const Route = createFileRoute("/artifacts/")({
  component: ArtifactsView,
});
