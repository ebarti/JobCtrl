import { DiscoveryProductControls } from "../../contexts/discovery/components/DiscoveryProductControls.js";
import { DiscoveryRuntimeSettingsPanel } from "../../contexts/discovery/components/DiscoveryRuntimeSettingsPanel.js";
import { DiscoveryAutomationSettingsPanel } from "../../contexts/discovery/components/DiscoveryAutomationSettingsPanel.js";
import { TargetSearchSettingsPanel } from "../../contexts/profile/components/TargetSearchSettingsPanel.js";
import { PageHead } from "../../shared/ui/page-head.js";

export function DiscoveryView() {
  return (
    <div className="route-page route-page--discovery">
      <PageHead
        eyebrow="Pipeline"
        title="Discovery"
        subtitle="Search defaults, source execution, supervision, and intake controls."
      />
      <div className="discovery-view-stack">
        <TargetSearchSettingsPanel />
        <DiscoveryAutomationSettingsPanel />
        <DiscoveryRuntimeSettingsPanel />
        <DiscoveryProductControls layout="tabs" />
      </div>
    </div>
  );
}
