import { DiscoveryProductControls } from "../../contexts/discovery/components/DiscoveryProductControls.js";
import { DiscoveryRuntimeSettingsPanel } from "../../contexts/discovery/components/DiscoveryRuntimeSettingsPanel.js";
import { DiscoveryAutomationSettingsPanel } from "../../contexts/discovery/components/DiscoveryAutomationSettingsPanel.js";
import { TargetSearchSettingsPanel } from "../../contexts/profile/components/TargetSearchSettingsPanel.js";
import { PageHead } from "../../shared/ui/page-head.js";

export function DiscoveryView() {
  return (
    <>
      <PageHead eyebrow="Pipeline" title="Discovery" />
      <div className="discovery-view-stack">
        <TargetSearchSettingsPanel />
        <DiscoveryAutomationSettingsPanel />
        <DiscoveryRuntimeSettingsPanel />
        <DiscoveryProductControls layout="tabs" />
      </div>
    </>
  );
}
