import { createFileRoute } from "@tanstack/react-router";

// The comparison list belongs to the parent so opening a job preserves it.
export const Route = createFileRoute("/jobs/")({ component: () => null });
