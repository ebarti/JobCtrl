import { DiscoveryProductControls } from "../../contexts/discovery/components/DiscoveryProductControls.js";
import { DiscoveryRuntimeSettingsPanel } from "../../contexts/discovery/components/DiscoveryRuntimeSettingsPanel.js";
import { DiscoveryAutomationSettingsPanel } from "../../contexts/profile/components/DiscoveryAutomationSettingsPanel.js";
import { TargetSearchSettingsPanel } from "../../contexts/profile/components/TargetSearchSettingsPanel.js";

export function DiscoveryView() {
  return (
    <div className="discovery-view-stack">
      <TargetSearchSettingsPanel />
      <DiscoveryAutomationSettingsPanel />
      <DiscoveryRuntimeSettingsPanel />
      <DiscoveryProductControls layout="tabs" />
    </div>
  );
}
