import { createFileRoute } from "@tanstack/react-router";

import { DiscoveryView } from "../views/discovery/DiscoveryView.js";

export const Route = createFileRoute("/discovery")({
  component: DiscoveryView,
});
