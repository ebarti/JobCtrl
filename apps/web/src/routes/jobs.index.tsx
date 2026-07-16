import { createFileRoute } from "@tanstack/react-router";

import { JobsView } from "../views/jobs/JobsView.js";

export const Route = createFileRoute("/jobs/")({
  component: JobsView,
});
