import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/artifacts/")({
  component: ArtifactsIndexComponent,
});

function ArtifactsIndexComponent() {
  return null;
}
