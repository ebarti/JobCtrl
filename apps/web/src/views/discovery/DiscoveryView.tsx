import {
  DiscoveryProductControls,
  type DiscoverySourceTableControls,
} from "../../contexts/discovery/components/DiscoveryProductControls.js";
import { DiscoveryRuntimeSettingsPanel } from "../../contexts/discovery/components/DiscoveryRuntimeSettingsPanel.js";
import { DiscoveryAutomationSettingsPanel } from "../../contexts/discovery/components/DiscoveryAutomationSettingsPanel.js";
import { DiscoveryRunsPanel } from "../../contexts/discovery/components/DiscoveryRunsPanel.js";
import { DiscoveryExplicitTargets } from "../../contexts/discovery/components/DiscoveryExplicitTargets.js";
import { DiscoveryTargetPlan } from "../../contexts/discovery/components/DiscoveryTargetPlan.js";
import { TargetSearchSettingsPanel } from "../../contexts/profile/components/TargetSearchSettingsPanel.js";
import { PageHead } from "../../shared/ui/page-head.js";

export function DiscoveryView({
  sourceTable,
}: {
  readonly sourceTable?: DiscoverySourceTableControls;
} = {}) {
  return (
    <>
      <PageHead eyebrow="Pipeline" title="Discovery" />
      <div className="discovery-view-stack discovery-workspace">
        <DiscoveryRunsPanel />
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
          <DiscoveryTargetPlan />
          <DiscoveryExplicitTargets />
        </div>
        <div className="discovery-task-section" id="discovery-automation">
          <DiscoveryAutomationSettingsPanel />
        </div>
        <div className="discovery-task-section" id="discovery-runtime">
          <DiscoveryRuntimeSettingsPanel />
        </div>
        <div className="discovery-task-section" id="discovery-source-controls">
          <DiscoveryProductControls
            layout="tabs"
            {...(sourceTable ? { sourceTable } : {})}
          />
        </div>
      </div>
    </>
  );
}
