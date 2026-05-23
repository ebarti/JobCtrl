import { StageTriggerPanel } from "../../contexts/pipeline/components/StageTriggerPanel.js";
import { CardHeader } from "../../shared/ui/card-header.js";

export function PipelinesView() {
  return (
    <StageTriggerPanel stagePanels={{ discover: <DiscoverStagePanel /> }} />
  );
}

function DiscoverStagePanel() {
  return (
    <section className="card full discovery-stage-panel">
      <CardHeader title="Discovery" meta="source controls" />
      <div className="stage-discovery-link">
        <a href="/discovery">Open Discovery</a>
      </div>
    </section>
  );
}
