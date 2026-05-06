import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/jobs/")({
  component: JobsIndexComponent,
});

function JobsIndexComponent() {
  return null;
}
