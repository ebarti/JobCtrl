import { createFileRoute } from "@tanstack/react-router";

import { ModelSelectionPanel } from "../contexts/profile/components/ModelSelectionPanel.js";
import { AiExecutionPolicyPanel } from "../contexts/materials/components/AiExecutionPolicyPanel.js";

export const Route = createFileRoute("/settings/models")({
  component: ModelsSettingsRoute,
});

function ModelsSettingsRoute() {
  return (
    <div className="models-settings-sections grid gap-[18px]">
      <header className="settings-subroute-head">
        <h2>Models and execution policy</h2>
        <p>Choose explicit providers for analysis, generation, fallback, and judging.</p>
      </header>
      <ModelSelectionPanel />
      <AiExecutionPolicyPanel />
    </div>
  );
}
