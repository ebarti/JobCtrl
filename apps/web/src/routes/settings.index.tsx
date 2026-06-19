import { createFileRoute } from "@tanstack/react-router";

import { SettingsPanel } from "../contexts/profile/components/SettingsPanel.js";
import { CompensationSourcePolicyPanel } from "../contexts/scoring/components/CompensationSourcePolicyPanel.js";

export const Route = createFileRoute("/settings/")({
  component: SettingsIndexRoute,
});

function SettingsIndexRoute() {
  return (
    <>
      <SettingsPanel />
      <CompensationSourcePolicyPanel />
    </>
  );
}
