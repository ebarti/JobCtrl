import { DiscoveryProductControls } from "../../contexts/discovery/components/DiscoveryProductControls.js";
import { DiscoveryRuntimeSettingsPanel } from "../../contexts/discovery/components/DiscoveryRuntimeSettingsPanel.js";
import { DiscoveryAutomationSettingsPanel } from "../../contexts/discovery/components/DiscoveryAutomationSettingsPanel.js";
import { TargetSearchSettingsPanel } from "../../contexts/profile/components/TargetSearchSettingsPanel.js";
import { PageHead } from "../../shared/ui/page-head.js";

export function DiscoveryView() {
  return (
    <>
      <PageHead eyebrow="Pipeline" title="Discovery" />
      <div className="discovery-view-stack discovery-workspace">
        <nav className="discovery-section-nav" aria-label="Discovery sections">
          <a data-typography="control" href="#discovery-target-search">
            Target search
          </a>
          <a data-typography="control" href="#discovery-automation">
            Automation
          </a>
          <a data-typography="control" href="#discovery-runtime">
            Runtime
          </a>
          <a data-typography="control" href="#discovery-source-controls">
            Source controls
          </a>
        </nav>
        <div className="discovery-task-section" id="discovery-target-search">
          <TargetSearchSettingsPanel />
        </div>
        <div className="discovery-task-section" id="discovery-automation">
          <DiscoveryAutomationSettingsPanel />
        </div>
        <div className="discovery-task-section" id="discovery-runtime">
          <DiscoveryRuntimeSettingsPanel />
        </div>
        <div className="discovery-task-section" id="discovery-source-controls">
          <DiscoveryProductControls layout="tabs" />
        </div>
      </div>
    </>
  );
}
