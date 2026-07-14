import { createFileRoute } from "@tanstack/react-router";

import { BrowserCapabilitiesPanel } from "../contexts/operations/components/BrowserCapabilitiesPanel.js";
import { ExtensionPairingPanel } from "../contexts/operations/components/ExtensionPairingPanel.js";

export const Route = createFileRoute("/settings/browser")({
  component: BrowserSettingsRoute,
});

function BrowserSettingsRoute() {
  return (
    <div className="settings-browser-sections">
      <BrowserCapabilitiesPanel />
      <ExtensionPairingPanel />
    </div>
  );
}
