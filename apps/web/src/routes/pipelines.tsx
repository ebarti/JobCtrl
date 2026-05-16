import { createFileRoute } from "@tanstack/react-router";

import { PipelinesView } from "../views/pipelines/PipelinesView.js";

export const Route = createFileRoute("/pipelines")({
  component: PipelinesView,
});
