import { createFileRoute } from "@tanstack/react-router";

import { ModelSelectionPanel } from "../contexts/profile/components/ModelSelectionPanel.js";
import { AiExecutionPolicyPanel } from "../contexts/materials/components/AiExecutionPolicyPanel.js";

export const Route = createFileRoute("/settings/models")({
  component: ModelsSettingsRoute,
});

function ModelsSettingsRoute() {
  return <><ModelSelectionPanel /><AiExecutionPolicyPanel /></>;
}
