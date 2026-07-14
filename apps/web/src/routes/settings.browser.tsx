import { createFileRoute } from "@tanstack/react-router";

import { BrowserCapabilitiesPanel } from "../contexts/operations/components/BrowserCapabilitiesPanel.js";
import { ExtensionPairingPanel } from "../contexts/operations/components/ExtensionPairingPanel.js";

export const Route = createFileRoute("/settings/browser")({
  component: BrowserSettingsRoute,
});

function BrowserSettingsRoute() {
  return (
    <div className="settings-browser-sections">
      <header className="settings-browser-intro">
        <h2>Browser and extension</h2>
        <p>Optional capabilities are explicit, revocable, and scoped to local JobCtrl workflows.</p>
      </header>
      <BrowserCapabilitiesPanel />
      <ExtensionPairingPanel />
    </div>
  );
}
