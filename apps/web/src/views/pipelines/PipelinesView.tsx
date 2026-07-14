import { StageTriggerPanel } from "../../contexts/pipeline/components/StageTriggerPanel.js";
import { PageHead } from "../../shared/ui/page-head.js";

export function PipelinesView() {
  return (
    <div className="route-page route-page--pipelines">
      <PageHead eyebrow="Pipeline" title="Pipelines" />
      <StageTriggerPanel />
    </div>
  );
}
