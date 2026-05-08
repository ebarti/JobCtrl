import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/runs/")({
  component: RunsIndexComponent,
});

function RunsIndexComponent() {
  return null;
}
