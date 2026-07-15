import { PipelineOperationsWorkspace } from "../../contexts/pipeline/components/PipelineOperationsWorkspace.js";
import { PageHead } from "../../shared/ui/page-head.js";

export function PipelinesView() {
  return (
    <div className="pipelines-view">
      <PageHead
        eyebrow="Pipeline"
        title="Pipelines"
        subtitle="Follow the current discovery execution, the backlog around it, and the capacity doing the work."
      />
      <PipelineOperationsWorkspace />
    </div>
  );
}
