import { createFileRoute } from "@tanstack/react-router";

import { ModelSelectionPanel } from "../contexts/profile/components/ModelSelectionPanel.js";

export const Route = createFileRoute("/settings/models")({
  component: ModelSelectionPanel,
});
