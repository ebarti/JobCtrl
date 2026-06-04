import { DiscoveryProductControls } from "../../contexts/discovery/components/DiscoveryProductControls.js";
import { DiscoveryRuntimeSettingsPanel } from "../../contexts/discovery/components/DiscoveryRuntimeSettingsPanel.js";
import { TargetSearchSettingsPanel } from "../../contexts/profile/components/TargetSearchSettingsPanel.js";

export function DiscoveryView() {
  return (
    <div className="discovery-view-stack">
      <TargetSearchSettingsPanel />
      <DiscoveryRuntimeSettingsPanel />
      <DiscoveryProductControls layout="tabs" />
    </div>
  );
}
