import { StageTriggerPanel } from "../../contexts/pipeline/components/StageTriggerPanel.js";
import { PageHead } from "../../shared/ui/page-head.js";

export function PipelinesView() {
  return (
    <>
      <PageHead eyebrow="Pipeline" title="Pipelines" />
      <StageTriggerPanel />
    </>
  );
}
