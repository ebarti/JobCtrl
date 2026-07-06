import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/outreach/")({
  component: OutreachIndexComponent,
});

function OutreachIndexComponent() {
  return null;
}
