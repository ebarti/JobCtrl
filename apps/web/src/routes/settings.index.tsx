import { createFileRoute } from "@tanstack/react-router";

import { SettingsPanel } from "../contexts/profile/components/SettingsPanel.js";

export const Route = createFileRoute("/settings/")({
  component: SettingsPanel,
});
