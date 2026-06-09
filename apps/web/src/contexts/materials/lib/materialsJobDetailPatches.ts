import type { MaterialStage } from "@jobhunter/contracts";

import type { JobDetail } from "../../operations/types.js";

function isJobDetail(value: unknown): value is JobDetail {
  return (
    typeof value === "object" &&
    value !== null &&
    "job" in value &&
    "stages" in value &&
    Array.isArray((value as JobDetail).stages)
  );
}

/**
 * Optimistically mark a material stage as `running` on a cached job detail so the
 * UI reflects the queued generation immediately. Mirrors the pipeline context's
 * `patchStageState`, scoped to material stages so the materials context owns its
 * own optimistic patch (a context never imports another context's lib).
 */
export function patchStageRunning(current: unknown, stage: MaterialStage): unknown {
  if (!isJobDetail(current)) {
    return current;
  }
  return {
    ...current,
    stages: current.stages.map((entry) =>
      entry.stage === stage ? { ...entry, state: "running" } : entry,
    ),
  };
}
