import { createFileRoute } from "@tanstack/react-router";

import { OutreachView } from "../views/outreach/OutreachView.js";

export const Route = createFileRoute("/outreach/")({
  component: OutreachView,
});
