import { createFileRoute } from "@tanstack/react-router";

import { SettingsPanel } from "../contexts/profile/components/SettingsPanel.js";
import { CompensationSourcePolicyPanel } from "../contexts/scoring/components/CompensationSourcePolicyPanel.js";
import { ScoringGuidancePanel } from "../contexts/scoring/components/ScoringGuidancePanel.js";
import { ApplyRuntimeSettingsPanel } from "../contexts/apply/components/ApplyRuntimeSettingsPanel.js";

export const Route = createFileRoute("/settings/")({
  component: SettingsIndexRoute,
});

function SettingsIndexRoute() {
  return (
    <div className="settings-general-sections grid gap-4">
      <SettingsPanel />
      <ApplyRuntimeSettingsPanel />
      <ScoringGuidancePanel />
      <CompensationSourcePolicyPanel />
    </div>
  );
}
