import { createFileRoute } from "@tanstack/react-router";

import { ApplicationSettingsPanel } from "../contexts/settings/index.js";

export const Route = createFileRoute("/settings/models")({
  component: ModelsSettingsRoute,
});

function ModelsSettingsRoute() {
  return <ApplicationSettingsPanel section="models" />;
}
