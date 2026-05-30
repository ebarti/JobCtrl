import { DiscoveryProductControls } from "../../contexts/discovery/components/DiscoveryProductControls.js";
import { TargetSearchSettingsPanel } from "../../contexts/profile/components/TargetSearchSettingsPanel.js";

export function DiscoveryView() {
  return (
    <div className="discovery-view-stack">
      <TargetSearchSettingsPanel />
      <DiscoveryProductControls layout="tabs" />
    </div>
  );
}
