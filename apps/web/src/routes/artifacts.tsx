import { createFileRoute } from "@tanstack/react-router";

import { ArtifactsView } from "../views/artifacts/ArtifactsView.js";
import { artifactsSearchSchema } from "./-artifacts.search.js";

export const Route = createFileRoute("/artifacts")({
  validateSearch: (search) => artifactsSearchSchema.parse(search),
  component: ArtifactsView,
});
