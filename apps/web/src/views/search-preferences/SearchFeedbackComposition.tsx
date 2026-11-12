import type { DiscoverySearchFeedbackRenderer, DiscoverySearchController } from "../../contexts/discovery/index.js";
import { useSearchPreparationProgress } from "../../contexts/pipeline/index.js";
import { useMountedFeatures } from "../../contexts/runtime/index.js";

function SearchFeedbackComposition({ controller, render }: { controller: DiscoverySearchController; render: Parameters<DiscoverySearchFeedbackRenderer>[1] }) {
  const features = useMountedFeatures();
  const active = Boolean(controller.action && ["pending", "queued", "running"].includes(controller.action.status));
  const enabled = features.has("preparation") && controller.assessmentAvailable !== false;
  const progress = useSearchPreparationProgress({ runId: controller.action?.runId ?? null,
    databaseInstanceId: controller.workspace?.databaseInstanceId, enabled, active });
  return render({ phase: progress.isError ? null : progress.data?.phase ?? null, assessedJobs: progress.data?.assessedJobs ?? null,
    failedJobs: progress.data?.failedJobs ?? null, totalJobs: progress.data?.totalJobs ?? null,
    failures: progress.data?.failures ?? [], unavailable: enabled && Boolean(progress.error) });
}

/** Shell composition joins exact public run identities without cross-feature private imports. */
export const renderSearchFeedback: DiscoverySearchFeedbackRenderer = (controller, render) => <SearchFeedbackComposition controller={controller} render={render} />;
