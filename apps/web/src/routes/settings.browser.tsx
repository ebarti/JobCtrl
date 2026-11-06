import { createFileRoute } from "@tanstack/react-router";

import { BrowserCapabilitiesPanel, ExtensionPairingPanel } from "../contexts/browser/index.js";

export const Route = createFileRoute("/settings/browser")({
  component: BrowserSettingsRoute,
});

function BrowserSettingsRoute() {
  return (
    <>
      <BrowserCapabilitiesPanel />
      <ExtensionPairingPanel />
    </>
  );
}
