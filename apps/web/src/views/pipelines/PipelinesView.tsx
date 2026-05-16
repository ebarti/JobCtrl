import { DiscoveryProductControls } from "../../contexts/discovery/components/DiscoveryProductControls.js";
import { StageTriggerPanel } from "../../contexts/pipeline/components/StageTriggerPanel.js";

export function PipelinesView() {
  return <StageTriggerPanel stagePanels={{ discover: <DiscoveryProductControls /> }} />;
}
