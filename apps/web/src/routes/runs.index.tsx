import { createFileRoute } from "@tanstack/react-router";

import { RunsView } from "../views/runs/RunsView.js";

export const Route = createFileRoute("/runs/")({
  component: RunsView,
});
